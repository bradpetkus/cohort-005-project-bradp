import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  comments,
  coupons,
  courses,
  lessons,
  modules,
  notifications,
  notificationSources,
  purchases,
  refunds,
  users,
  UserRole,
  NotificationSourceKind,
  NotificationType,
} from "~/db/schema";

// ─── Notifications ───
// The only place that knows notification rules: who hears about an event,
// bundling, and the bell. See GLOSSARY.md (Notification, Announcement) and
// PRD #12.
//
// Every function takes the database first and, where time matters, an
// explicit `now` last, so tests can pass an in-memory database and a fixed
// time. Push is never sent from here: recording an event *returns* the push
// messages to deliver, the way refund functions return an Email.

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

// ─── Domain events ───

export type NotificationEvent =
  | {
      type: "comment_reply";
      commentId: number;
    }
  | RefundNotificationEvent;

export type PushMessage = {
  userId: number;
  title: string;
  body: string;
  tag: string;
  url: string;
};

export type RecordResult = { pushMessages: PushMessage[] };

export function recordNotificationEvent(
  db: Db,
  event: NotificationEvent,
  now: Date
): RecordResult {
  switch (event.type) {
    case "comment_reply":
      return recordReply(db, event.commentId, now);
    case "refund_requested":
      return recordRefundRequested(db, event.refundRequestId, now);
    case "refund_decided":
      return recordRefundDecided(db, event, now);
  }
}

function recordReply(db: Db, commentId: number, now: Date): RecordResult {
  const replyRow = db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      lessonId: comments.lessonId,
      actorId: comments.userId,
      actorName: users.name,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(comments.id, commentId))
    .get();
  if (!replyRow || replyRow.parentId === null) return { pushMessages: [] };

  const threadId = replyRow.parentId;
  const thread = db
    .select({ userId: comments.userId })
    .from(comments)
    .where(eq(comments.id, threadId))
    .get();
  if (!thread) return { pushMessages: [] };

  // Earlier repliers: every reply in the thread before this one.
  const earlierRepliers = db
    .select({ userId: comments.userId })
    .from(comments)
    .where(and(eq(comments.parentId, threadId), lt(comments.id, replyRow.id)))
    .all()
    .map((r) => r.userId);

  const recipients = new Set([thread.userId, ...earlierRepliers]);
  recipients.delete(replyRow.actorId);

  db.transaction((tx) => {
    for (const recipientId of recipients) {
      notify(
        tx,
        {
          recipientId,
          type: NotificationType.Reply,
          bundleKey: `thread:${threadId}`,
          actorName: replyRow.actorName,
          courseTitle: replyRow.courseTitle,
          subjectTitle: replyRow.lessonTitle,
          detail:
            recipientId === thread.userId ? REPLY_ON_OWN : REPLY_IN_THREAD,
          note: null,
          destinationUrl: `/courses/${replyRow.courseSlug}/lessons/${replyRow.lessonId}#comment-${threadId}`,
        },
        {
          kind: NotificationSourceKind.Comment,
          id: replyRow.id,
          lessonId: replyRow.lessonId,
        },
        now
      );
    }
  });

  return { pushMessages: [] };
}

// Reply `detail`: is the recipient the thread's top-level author?
const REPLY_ON_OWN = "own_comment";
const REPLY_IN_THREAD = "thread";

// ─── Refund Requests ───

export type RefundNotificationEvent =
  | { type: "refund_requested"; refundRequestId: number }
  | {
      type: "refund_decided";
      refundRequestId: number;
      decision: "approved" | "declined";
      // From the approve result: true only when the buyer's Enrollment was
      // really removed (docs/adr/0004).
      enrollmentEnded: boolean;
    };

function getRefundRequest(db: Db, refundRequestId: number) {
  return db
    .select({
      id: refunds.id,
      purchaseId: purchases.id,
      buyerId: purchases.userId,
      buyerName: users.name,
      courseId: courses.id,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
      deciderId: refunds.resolvedByUserId,
      decisionNote: refunds.decisionNote,
    })
    .from(refunds)
    .innerJoin(purchases, eq(purchases.id, refunds.purchaseId))
    .innerJoin(users, eq(users.id, purchases.userId))
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(eq(refunds.id, refundRequestId))
    .get();
}

// Every Platform Admin but the buyer gets their own row: never bundled, so
// each decision stays separate.
function recordRefundRequested(
  db: Db,
  refundRequestId: number,
  now: Date
): RecordResult {
  const request = getRefundRequest(db, refundRequestId);
  if (!request) return { pushMessages: [] };

  const admins = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, UserRole.Admin))
    .all()
    .map((u) => u.id)
    .filter((id) => id !== request.buyerId);

  db.transaction((tx) => {
    for (const recipientId of admins) {
      notify(
        tx,
        {
          recipientId,
          type: NotificationType.RefundRequest,
          bundleKey: null,
          actorName: request.buyerName,
          courseTitle: request.courseTitle,
          subjectTitle: null,
          detail: null,
          note: null,
          destinationUrl: "/admin/refunds",
        },
        {
          kind: NotificationSourceKind.RefundRequest,
          id: request.id,
          lessonId: null,
        },
        now
      );
    }
  });

  return { pushMessages: [] };
}

// The buyer (Student or Team Admin) hears the outcome, with the note.
function recordRefundDecided(
  db: Db,
  event: Extract<RefundNotificationEvent, { type: "refund_decided" }>,
  now: Date
): RecordResult {
  const request = getRefundRequest(db, event.refundRequestId);
  if (!request) return { pushMessages: [] };

  // A Purchase with Seats is a Team Licence, whose buyer is its Team Admin.
  const isTeamLicence =
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(eq(coupons.purchaseId, request.purchaseId))
      .get() !== undefined;

  const source = {
    kind: NotificationSourceKind.RefundRequest,
    id: request.id,
    lessonId: null,
  };

  db.transaction((tx) => {
    // The request is done, so no Platform Admin needs to open it any more.
    // The decider's own row goes too: they've just handled it.
    tx.update(notifications)
      .set({ readAt: now.toISOString() })
      .where(
        and(
          eq(notifications.type, NotificationType.RefundRequest),
          isNull(notifications.readAt),
          inArray(
            notifications.id,
            tx
              .select({ id: notificationSources.notificationId })
              .from(notificationSources)
              .where(
                and(
                  eq(
                    notificationSources.sourceKind,
                    NotificationSourceKind.RefundRequest
                  ),
                  eq(notificationSources.sourceId, request.id)
                )
              )
          )
        )
      )
      .run();

    if (request.buyerId !== request.deciderId) {
      notify(
        tx,
        {
          recipientId: request.buyerId,
          type: NotificationType.RefundDecision,
          bundleKey: null,
          actorName: null,
          courseTitle: request.courseTitle,
          subjectTitle: null,
          detail: event.decision,
          note: request.decisionNote,
          destinationUrl: isTeamLicence ? "/team" : "/settings",
        },
        source,
        now
      );
    }

    // In-app only, never bundled.
    if (
      event.decision === "approved" &&
      event.enrollmentEnded &&
      request.instructorId !== request.deciderId
    ) {
      notify(
        tx,
        {
          recipientId: request.instructorId,
          type: NotificationType.EnrollmentEnded,
          bundleKey: null,
          actorName: request.buyerName,
          courseTitle: request.courseTitle,
          subjectTitle: null,
          detail: null,
          note: null,
          destinationUrl: `/instructor/${request.courseId}/students`,
        },
        source,
        now
      );
    }
  });

  return { pushMessages: [] };
}

// ─── Creating and merging bell rows ───

type BellRowFields = {
  recipientId: number;
  type: NotificationType;
  // Null for types that never bundle.
  bundleKey: string | null;
  actorName: string | null;
  courseTitle: string | null;
  subjectTitle: string | null;
  detail: string | null;
  note: string | null;
  destinationUrl: string;
};

type Source = { kind: NotificationSourceKind; id: number; lessonId: number | null };

// Merges into the recipient's unread row with the same bundle key, moving it
// to the top and its display fields to the latest event, or starts a new row.
function notify(tx: Queryable, fields: BellRowFields, source: Source, now: Date) {
  const iso = now.toISOString();

  const open =
    fields.bundleKey === null
      ? undefined
      : tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.recipientId, fields.recipientId),
              eq(notifications.bundleKey, fields.bundleKey),
              isNull(notifications.readAt)
            )
          )
          .get();

  let notificationId: number;
  if (open) {
    notificationId = open.id;
    tx.update(notifications)
      .set({
        ...fields,
        eventCount: sql`${notifications.eventCount} + 1`,
        lastEventAt: iso,
      })
      .where(eq(notifications.id, open.id))
      .run();
  } else {
    notificationId = tx
      .insert(notifications)
      .values({ ...fields, createdAt: iso, lastEventAt: iso })
      .returning({ id: notifications.id })
      .get().id;
  }

  tx.insert(notificationSources)
    .values({
      notificationId,
      sourceKind: source.kind,
      sourceId: source.id,
      lessonId: source.lessonId,
    })
    .run();
}

// ─── Reading the bell ───

export type BellRow = {
  id: number;
  type: NotificationType;
  title: string;
  snippet: string;
  lastEventAt: string;
  unread: boolean;
  pushed: boolean;
  url: string;
};

type NotificationRow = typeof notifications.$inferSelect;

function titleFor(row: NotificationRow): string {
  switch (row.type) {
    case NotificationType.Reply: {
      const where =
        row.detail === REPLY_ON_OWN
          ? `your comment on ${row.subjectTitle}`
          : `a thread you're in on ${row.subjectTitle}`;
      if (row.eventCount > 1) {
        return `${row.eventCount} new replies ${row.detail === REPLY_ON_OWN ? "on" : "in"} ${where}`;
      }
      return `${row.actorName} replied ${row.detail === REPLY_ON_OWN ? "to" : "in"} ${where}`;
    }
    case NotificationType.RefundRequest:
      return `${row.actorName} requested a refund for ${row.courseTitle}`;
    case NotificationType.RefundDecision:
      return `Your Refund Request for ${row.courseTitle} was ${row.detail}`;
    case NotificationType.EnrollmentEnded:
      return `${row.actorName} left ${row.courseTitle} after a refund`;
    default:
      return "";
  }
}

function snippetFor(row: NotificationRow): string {
  switch (row.type) {
    case NotificationType.RefundDecision:
      return row.note ?? row.courseTitle ?? "";
    default:
      return row.courseTitle ?? "";
  }
}

// The badge: every unread row, including ones past the dropdown's cap.
export function getUnreadCount(db: Db, userId: number): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
      )
      .get()?.count ?? 0
  );
}

export const BELL_LIMIT = 30;

// The newest rows by latest event, ready to render. A bundle is one row.
export function listBell(db: Db, userId: number): BellRow[] {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, userId))
    .orderBy(desc(notifications.lastEventAt), desc(notifications.id))
    .limit(BELL_LIMIT)
    .all()
    .map((row) => ({
      id: row.id,
      type: row.type,
      title: titleFor(row),
      snippet: snippetFor(row),
      lastEventAt: row.lastEventAt,
      unread: row.readAt === null,
      pushed: row.pushed,
      url: row.destinationUrl,
    }));
}

// ─── Read state ───
// Both act only on the person's own rows. A bundle is a single row, so
// marking it read covers every event in it.

// Returns the row's destination, or null if it isn't the person's row.
export function markNotificationRead(
  db: Db,
  userId: number,
  notificationId: number,
  now: Date
): string | null {
  const row = db
    .select({
      readAt: notifications.readAt,
      destinationUrl: notifications.destinationUrl,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientId, userId)
      )
    )
    .get();
  if (!row) return null;

  if (row.readAt === null) {
    db.update(notifications)
      .set({ readAt: now.toISOString() })
      .where(eq(notifications.id, notificationId))
      .run();
  }
  return row.destinationUrl;
}

export function markAllNotificationsRead(
  db: Db,
  userId: number,
  now: Date
): void {
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
    )
    .run();
}
