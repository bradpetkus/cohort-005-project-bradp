import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  comments,
  courses,
  lessons,
  modules,
  notifications,
  notificationSources,
  users,
  NotificationSourceKind,
  NotificationType,
} from "~/db/schema";
import { coupons, enrollments, purchases, UserRole } from "~/db/schema";

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
  | { type: "comment_reply"; commentId: number }
  | { type: "new_question"; commentId: number }
  | BusinessEvent;

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
    case "new_question":
      return recordQuestion(db, event.commentId, now);
    case "purchase_made":
    case "enrollment_gained":
    case "seat_claimed":
      return recordBusinessEvent(db, event, now);
  }
}

// A new top-level comment notifies the course's Instructor, never the asker.
// Questions bundle by lesson and all lead to the Questions queue.
function recordQuestion(db: Db, commentId: number, now: Date): RecordResult {
  const question = db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      lessonId: comments.lessonId,
      actorId: comments.userId,
      actorName: users.name,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(comments.id, commentId))
    .get();
  if (!question || question.parentId !== null) return { pushMessages: [] };
  if (question.instructorId === question.actorId) return { pushMessages: [] };

  db.transaction((tx) => {
    notify(
      tx,
      {
        recipientId: question.instructorId,
        type: NotificationType.Question,
        bundleKey: `lesson:${question.lessonId}`,
        actorName: question.actorName,
        courseTitle: question.courseTitle,
        subjectTitle: question.lessonTitle,
        detail: null,
        note: null,
        destinationUrl: "/instructor/questions",
      },
      {
        kind: NotificationSourceKind.Comment,
        id: question.id,
        lessonId: question.lessonId,
      },
      now
    );
  });

  return { pushMessages: [] };
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

type Source = {
  kind: NotificationSourceKind;
  id: number;
  lessonId: number | null;
};

// Merges into the recipient's unread row with the same bundle key, moving it
// to the top and its display fields to the latest event, or starts a new row.
function notify(
  tx: Queryable,
  fields: BellRowFields,
  source: Source,
  now: Date
) {
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
    case NotificationType.Question:
      if (row.eventCount > 1) {
        return `${row.eventCount} new questions on ${row.subjectTitle}`;
      }
      return `${row.actorName} asked a question on ${row.subjectTitle}`;
    case NotificationType.Purchase:
    case NotificationType.EnrollmentGained:
    case NotificationType.SeatClaimed:
      return businessTitleFor(row);
    default:
      return "";
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
      snippet: row.courseTitle ?? "",
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

// ─── Business activity (#16) ───
// Purchases, Enrollments gained and Seats claimed. In-app only: these never
// push. Each bundles into one unread row per recipient and bundle key.

export type BusinessEvent =
  | { type: "purchase_made"; purchaseId: number }
  | {
      type: "enrollment_gained";
      userId: number;
      courseId: number;
      via: "purchase" | "seat";
    }
  | { type: "seat_claimed"; seatId: number };

function recordBusinessEvent(
  db: Db,
  event: BusinessEvent,
  now: Date
): RecordResult {
  switch (event.type) {
    case "purchase_made":
      recordPurchase(db, event.purchaseId, now);
      break;
    case "enrollment_gained":
      recordEnrollmentGained(db, event.userId, event.courseId, event.via, now);
      break;
    case "seat_claimed":
      recordSeatClaimed(db, event.seatId, now);
      break;
  }
  return { pushMessages: [] };
}

function recordSeatClaimed(db: Db, seatId: number, now: Date) {
  const seat = db
    .select({
      purchaseId: coupons.purchaseId,
      claimerId: coupons.redeemedByUserId,
      actorName: users.name,
      courseTitle: courses.title,
    })
    .from(coupons)
    .innerJoin(users, eq(users.id, coupons.redeemedByUserId))
    .innerJoin(courses, eq(courses.id, coupons.courseId))
    .where(eq(coupons.id, seatId))
    .get();
  if (!seat) return;

  const buyer = db
    .select({ id: purchases.userId })
    .from(purchases)
    .where(eq(purchases.id, seat.purchaseId))
    .get();
  if (!buyer || buyer.id === seat.claimerId) return;

  notify(
    db,
    {
      recipientId: buyer.id,
      type: NotificationType.SeatClaimed,
      bundleKey: `team_licence:${seat.purchaseId}`,
      actorName: seat.actorName,
      courseTitle: seat.courseTitle,
      subjectTitle: null,
      detail: null,
      note: null,
      destinationUrl: "/team",
    },
    { kind: NotificationSourceKind.Seat, id: seatId, lessonId: null },
    now
  );
}

function recordEnrollmentGained(
  db: Db,
  userId: number,
  courseId: number,
  via: "purchase" | "seat",
  now: Date
) {
  const enrollment = db
    .select({
      id: enrollments.id,
      actorName: users.name,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
    })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .orderBy(desc(enrollments.id))
    .get();
  if (!enrollment || enrollment.instructorId === userId) return;

  // The source is the Enrollment, but an Enrollment ending never touches the
  // row: the bundled count is a record of who joined.
  notify(
    db,
    {
      recipientId: enrollment.instructorId,
      type: NotificationType.EnrollmentGained,
      bundleKey: `course_students:${courseId}`,
      actorName: enrollment.actorName,
      courseTitle: enrollment.courseTitle,
      subjectTitle: null,
      detail: via,
      note: null,
      destinationUrl: `/instructor/${courseId}/students`,
    },
    {
      kind: NotificationSourceKind.Enrollment,
      id: enrollment.id,
      lessonId: null,
    },
    now
  );
}

// Purchase `detail`: a Team Licence rather than an Individual Purchase.
const PURCHASE_TEAM_LICENCE = "team_licence";

function recordPurchase(db: Db, purchaseId: number, now: Date) {
  const purchase = db
    .select({
      actorId: purchases.userId,
      actorName: users.name,
      courseTitle: courses.title,
    })
    .from(purchases)
    .innerJoin(users, eq(users.id, purchases.userId))
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(eq(purchases.id, purchaseId))
    .get();
  if (!purchase) return;

  // A Team Licence is a Purchase that comes with Seats.
  const isTeamLicence = !!db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.purchaseId, purchaseId))
    .get();

  const admins = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, UserRole.Admin))
    .all()
    .filter((admin) => admin.id !== purchase.actorId);

  db.transaction((tx) => {
    for (const admin of admins) {
      notify(
        tx,
        {
          recipientId: admin.id,
          type: NotificationType.Purchase,
          bundleKey: "purchases",
          actorName: purchase.actorName,
          courseTitle: purchase.courseTitle,
          subjectTitle: null,
          detail: isTeamLicence ? PURCHASE_TEAM_LICENCE : null,
          note: null,
          destinationUrl: "/admin/courses",
        },
        {
          kind: NotificationSourceKind.Purchase,
          id: purchaseId,
          lessonId: null,
        },
        now
      );
    }
  });
}

function businessTitleFor(row: NotificationRow): string {
  switch (row.type) {
    case NotificationType.Purchase:
      if (row.eventCount > 1) return `${row.eventCount} new Purchases`;
      return row.detail === PURCHASE_TEAM_LICENCE
        ? `${row.actorName} bought a Team Licence for ${row.courseTitle}`
        : `${row.actorName} bought ${row.courseTitle}`;
    case NotificationType.EnrollmentGained:
      return row.eventCount > 1
        ? `${row.eventCount} new Students on ${row.courseTitle}`
        : `${row.actorName} enrolled in ${row.courseTitle}`;
    case NotificationType.SeatClaimed:
      return row.eventCount > 1
        ? `${row.eventCount} seats claimed on ${row.courseTitle}`
        : `${row.actorName} claimed a seat on ${row.courseTitle}`;
    default:
      return "";
  }
}
