import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { lte, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  announcements,
  comments,
  courses,
  lessonProgress,
  lessons,
  modules,
  notifications,
  notificationSources,
  pushPreferences,
  pushSubscriptions,
  quizzes,
  refunds,
  users,
  AnnouncementTargetKind,
  NotificationSourceKind,
  NotificationType,
  PushEventType,
} from "~/db/schema";
import { coupons, enrollments, purchases, UserRole } from "~/db/schema";
import { defaultPushTransport, type PushTransport } from "~/lib/push.server";
import { pushEventTypesFor as pushEventTypesForRole } from "~/lib/push";

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
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

// ─── Domain events ───

export type NotificationEvent =
  | { type: "comment_reply"; commentId: number }
  | { type: "new_question"; commentId: number }
  | { type: "announcement_sent"; announcementId: number }
  | BusinessEvent
  | RefundNotificationEvent
  | SourceDeletedEvent;

export type PushMessage = {
  userId: number;
  title: string;
  body: string;
  tag: string;
  url: string;
  // Only this one device of the person's (the test push). Otherwise every
  // device.
  endpoint?: string;
};

export type RecordResult = { pushMessages: PushMessage[] };

export function recordNotificationEvent(
  db: Db,
  event: NotificationEvent,
  now: Date
): RecordResult {
  deleteExpiredNotifications(db, now);
  switch (event.type) {
    case "comment_reply":
      return recordReply(db, event.commentId, now);
    case "new_question":
      return recordQuestion(db, event.commentId, now);
    case "announcement_sent":
      return recordAnnouncement(db, event.announcementId, now);
    case "purchase_made":
    case "enrollment_gained":
    case "seat_claimed":
      return recordBusinessEvent(db, event, now);
    case "refund_requested":
      return recordRefundRequested(db, event.refundRequestId, now);
    case "refund_decided":
      return recordRefundDecided(db, event, now);
    case "comment_deleted":
    case "lesson_deleted":
    case "quiz_deleted":
    case "module_deleted":
      return recordSourceDeleted(db, event);
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

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    const push = notify(
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
    if (push) pushMessages.push(push);
  });

  return { pushMessages };
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

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    for (const recipientId of recipients) {
      const push = notify(
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
      if (push) pushMessages.push(push);
    }
  });

  return { pushMessages };
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
      // From the approve result: the Students whose Enrollment was really
      // removed (docs/adr/0004). Empty for a decline.
      endedEnrollmentUserIds: number[];
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

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    for (const recipientId of admins) {
      const push = notify(
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
      if (push) pushMessages.push(push);
    }
  });

  return { pushMessages };
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

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    // The request is done, so no other Platform Admin needs to open it any
    // more. The decider's own row is left as it was.
    tx.update(notifications)
      .set({ readAt: now.toISOString() })
      .where(
        and(
          eq(notifications.type, NotificationType.RefundRequest),
          isNull(notifications.readAt),
          request.deciderId === null
            ? undefined
            : ne(notifications.recipientId, request.deciderId),
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
      const push = notify(
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
      if (push) pushMessages.push(push);
    }

    // In-app only, never bundled: one row per Enrollment that ended.
    const leavers =
      event.decision === "approved" &&
      event.endedEnrollmentUserIds.length > 0 &&
      request.instructorId !== request.deciderId
        ? tx
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, event.endedEnrollmentUserIds))
            .orderBy(users.id)
            .all()
        : [];
    for (const leaver of leavers) {
      notify(
        tx,
        {
          recipientId: request.instructorId,
          type: NotificationType.EnrollmentEnded,
          bundleKey: null,
          actorName: leaver.name,
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

  return { pushMessages };
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

type Source = {
  kind: NotificationSourceKind;
  id: number;
  lessonId: number | null;
};

// Merges into the recipient's unread row with the same bundle key, moving it
// to the top and its display fields to the latest event, or starts a new row.
// Returns the push message for this event, or null when it isn't pushed (see
// shouldPush). A pushed event sets the row's 📱 flag.
function notify(
  tx: Queryable,
  fields: BellRowFields,
  source: Source,
  now: Date
): PushMessage | null {
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

  if (!shouldPush(tx, fields.recipientId, fields.type)) return null;

  const row = tx
    .update(notifications)
    .set({ pushed: true })
    .where(eq(notifications.id, notificationId))
    .returning()
    .get();
  return pushMessageFor(row);
}

// ─── Channel decision ───
// Which push event type each Notification type belongs to. Null means the
// type is in-app only (Purchases, Enrollments and Seats).
const PUSH_EVENT_FOR: Record<NotificationType, PushEventType | null> = {
  [NotificationType.Reply]: PushEventType.Reply,
  [NotificationType.Question]: PushEventType.Question,
  [NotificationType.Announcement]: PushEventType.Announcement,
  [NotificationType.RefundDecision]: PushEventType.RefundDecision,
  [NotificationType.RefundRequest]: PushEventType.RefundRequest,
  [NotificationType.Purchase]: null,
  [NotificationType.EnrollmentGained]: null,
  [NotificationType.EnrollmentEnded]: null,
  [NotificationType.SeatClaimed]: null,
};

// Push when the event's channel includes push, the person hasn't muted that
// event type, and they have at least one device.
function shouldPush(
  tx: Queryable,
  userId: number,
  type: NotificationType
): boolean {
  const eventType = PUSH_EVENT_FOR[type];
  if (eventType === null) return false;
  if (isMuted(tx, userId, eventType)) return false;
  return hasDevice(tx, userId);
}

function isMuted(tx: Queryable, userId: number, eventType: PushEventType) {
  return (
    tx
      .select({ id: pushPreferences.id })
      .from(pushPreferences)
      .where(
        and(
          eq(pushPreferences.userId, userId),
          eq(pushPreferences.eventType, eventType)
        )
      )
      .get() !== undefined
  );
}

function hasDevice(tx: Queryable, userId: number) {
  return (
    tx
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .get() !== undefined
  );
}

// Lock-screen text says only what happened and where. It never includes
// comment text, an Announcement note or a decision note. The tag is the
// bundle key, so a bundle replaces its earlier push, or else a key unique to
// the row.
function pushMessageFor(row: NotificationRow): PushMessage {
  return {
    userId: row.recipientId,
    ...pushTextFor(row),
    tag: row.bundleKey ?? `notification:${row.id}`,
    url: row.destinationUrl,
  };
}

function pushTextFor(row: NotificationRow): { title: string; body: string } {
  switch (row.type) {
    case NotificationType.Announcement:
      // The same text the review step previews.
      return announcementPushText(
        row.subjectTitle ?? "",
        row.courseTitle ?? ""
      );
    case NotificationType.RefundDecision:
      return {
        title: `Your Refund Request was ${row.detail}`,
        body: row.courseTitle ?? "",
      };
    default:
      return { title: titleFor(row), body: row.courseTitle ?? "" };
  }
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
    case NotificationType.Announcement:
      return announcementBellTitle(
        row.actorName ?? "",
        row.detail === AnnouncementTargetKind.Quiz
          ? AnnouncementTargetKind.Quiz
          : AnnouncementTargetKind.Lesson,
        row.subjectTitle ?? ""
      );
    case NotificationType.RefundRequest:
      return `${row.actorName} requested a refund for ${row.courseTitle}`;
    case NotificationType.RefundDecision:
      return `Your Refund Request for ${row.courseTitle} was ${row.detail}`;
    case NotificationType.EnrollmentEnded:
      return `${row.actorName} left ${row.courseTitle} after a refund`;
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

function snippetFor(row: NotificationRow): string {
  switch (row.type) {
    case NotificationType.RefundDecision:
    case NotificationType.Announcement:
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

// ─── Push settings ───
// Devices are a person's push subscriptions. Every function here acts only on
// the given person's own data.

export type NewPushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceName: string;
};

// Saves this browser's subscription for the person. An endpoint belongs to
// one browser, so saving it again (new keys, or another person signed in on
// the same browser) moves it to this person.
export function savePushSubscription(
  db: Db,
  userId: number,
  subscription: NewPushSubscription,
  now: Date
): void {
  db.insert(pushSubscriptions)
    .values({ userId, ...subscription, createdAt: now.toISOString() })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        deviceName: subscription.deviceName,
      },
    })
    .run();
}

export { pushEventTypesFor } from "~/lib/push";

export type PushPreferences = Record<PushEventType, boolean>;

// Every event type is on unless the person muted it. Muting stops only the
// phone buzz; the bell still gets everything.
export function getPushPreferences(db: Db, userId: number): PushPreferences {
  const muted = new Set(
    db
      .select({ eventType: pushPreferences.eventType })
      .from(pushPreferences)
      .where(eq(pushPreferences.userId, userId))
      .all()
      .map((row) => row.eventType)
  );
  const preferences = {} as PushPreferences;
  for (const eventType of Object.values(PushEventType)) {
    preferences[eventType] = !muted.has(eventType);
  }
  return preferences;
}

// One choice per event type, applying to all of the person's devices.
export function setPushPreference(
  db: Db,
  userId: number,
  eventType: PushEventType,
  enabled: boolean
): void {
  if (enabled) {
    db.delete(pushPreferences)
      .where(
        and(
          eq(pushPreferences.userId, userId),
          eq(pushPreferences.eventType, eventType)
        )
      )
      .run();
  } else {
    db.insert(pushPreferences)
      .values({ userId, eventType })
      .onConflictDoNothing()
      .run();
  }
}

export type PushDevice = {
  id: number;
  endpoint: string;
  deviceName: string;
  createdAt: string;
};

export function listPushDevices(db: Db, userId: number): PushDevice[] {
  return db
    .select({
      id: pushSubscriptions.id,
      endpoint: pushSubscriptions.endpoint,
      deviceName: pushSubscriptions.deviceName,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(pushSubscriptions.id)
    .all();
}

// Removes one of the person's devices: this browser (by endpoint) or one from
// the device list (by id, "Stop sending").
export function removePushSubscription(
  db: Db,
  userId: number,
  device: { endpoint: string } | { id: number }
): void {
  const match =
    "endpoint" in device
      ? eq(pushSubscriptions.endpoint, device.endpoint)
      : eq(pushSubscriptions.id, device.id);
  db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), match))
    .run();
}

// What the Notifications card on /settings shows a person: their devices and
// one switch per push event type their role can receive. The switches can
// only be used once at least one device is on.
export type PushSettings = {
  devices: PushDevice[];
  events: { eventType: PushEventType; enabled: boolean }[];
  canChooseEvents: boolean;
};

export function getPushSettings(db: Db, userId: number): PushSettings {
  const user = db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  const devices = listPushDevices(db, userId);
  const preferences = getPushPreferences(db, userId);
  const eventTypes = user ? pushEventTypesForRole(user.role) : [];
  return {
    devices,
    events: eventTypes.map((eventType) => ({
      eventType,
      enabled: preferences[eventType],
    })),
    canChooseEvents: devices.length > 0,
  };
}

// The push sent to the device that has just turned push on.
export function testPushMessage(userId: number, endpoint: string): PushMessage {
  return {
    userId,
    title: "Phone notifications are on",
    body: "This is what Cadence notifications look like.",
    tag: "test",
    url: "/",
    endpoint,
  };
}

// ─── Delivering push ───

export type DeliveryReport = {
  delivered: number;
  gone: number;
  failed: number;
};

// Sends each message to every device of its recipient (or only the one it
// names) and deletes devices the push service reports gone (404/410).
// Failures are logged and never thrown, so push never fails the person's
// action.
export async function deliverPushMessages(
  db: Db,
  messages: PushMessage[],
  transport: PushTransport = defaultPushTransport()
): Promise<DeliveryReport> {
  const report: DeliveryReport = { delivered: 0, gone: 0, failed: 0 };

  for (const message of messages) {
    const devices = db
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, message.userId),
          message.endpoint === undefined
            ? undefined
            : eq(pushSubscriptions.endpoint, message.endpoint)
        )
      )
      .all();
    const payload = {
      title: message.title,
      body: message.body,
      tag: message.tag,
      url: message.url,
    };

    const outcomes = await Promise.all(
      devices.map(async (device) => {
        try {
          return await transport.send(device, payload);
        } catch (error) {
          console.error(`Push to device ${device.id} failed`, error);
          return "failed" as const;
        }
      })
    );

    outcomes.forEach((outcome, i) => {
      report[outcome] += 1;
      if (outcome === "gone") {
        db.delete(pushSubscriptions)
          .where(eq(pushSubscriptions.id, devices[i].id))
          .run();
      }
    });
  }

  if (report.failed > 0) {
    console.error(`${report.failed} push message(s) could not be delivered`);
  }
  return report;
}

// ─── Business activity (#16) ───
// Purchases, Enrollments gained and Seats claimed. In-app only: these never
// push. Each bundles into one unread row per recipient and bundle key.

export type BusinessEvent =
  | { type: "purchase_made"; purchaseId: number }
  | {
      type: "enrollment_gained";
      // The Enrollment this Purchase or Seat claim created. Record nothing
      // when the person was already enrolled.
      enrollmentId: number;
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
      recordEnrollmentGained(db, event.enrollmentId, event.via, now);
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
  enrollmentId: number,
  via: "purchase" | "seat",
  now: Date
) {
  const enrollment = db
    .select({
      id: enrollments.id,
      userId: enrollments.userId,
      courseId: enrollments.courseId,
      actorName: users.name,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
    })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .innerJoin(courses, eq(courses.id, enrollments.courseId))
    .where(eq(enrollments.id, enrollmentId))
    .get();
  if (!enrollment || enrollment.instructorId === enrollment.userId) return;

  // Each Enrollment counts once, however often it is reported.
  const alreadyCounted = db
    .select({ id: notificationSources.id })
    .from(notificationSources)
    .where(
      and(
        eq(notificationSources.sourceKind, NotificationSourceKind.Enrollment),
        eq(notificationSources.sourceId, enrollment.id)
      )
    )
    .get();
  if (alreadyCounted) return;
  const courseId = enrollment.courseId;

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

// ─── Announcements ───
// An Instructor points every Student with a current Enrollment at a lesson or
// quiz. Lapsed Students and the sender never get it, and each Announcement is
// its own bell row (never bundled). A quiz Announcement is stored by its
// lesson, because a quiz gets a new id on every save.

export type AnnouncementTarget = {
  kind: AnnouncementTargetKind;
  lessonId: number;
};

type Failure = { ok: false; status: number; error: string };

export const ANNOUNCEMENT_NOTE_MAX = 280;

// The bell row title, shared by the bell and the review step's preview.
function announcementBellTitle(
  senderName: string,
  kind: AnnouncementTargetKind,
  subjectTitle: string
): string {
  return kind === AnnouncementTargetKind.Quiz
    ? `${senderName} pointed you to the quiz “${subjectTitle}”`
    : `${senderName} pointed you to “${subjectTitle}”`;
}

type ResolvedTarget = {
  subjectTitle: string;
  courseTitle: string;
  courseSlug: string;
};

// What the lesson or quiz is called now, or null if it isn't on the course.
function resolveTarget(
  db: Queryable,
  courseId: number,
  target: AnnouncementTarget
): ResolvedTarget | null {
  const lesson = db
    .select({
      title: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(and(eq(lessons.id, target.lessonId), eq(courses.id, courseId)))
    .get();
  if (!lesson) return null;

  let subjectTitle = lesson.title;
  if (target.kind === AnnouncementTargetKind.Quiz) {
    const quiz = db
      .select({ title: quizzes.title })
      .from(quizzes)
      .where(eq(quizzes.lessonId, target.lessonId))
      .get();
    if (!quiz) return null;
    subjectTitle = quiz.title;
  }
  return {
    subjectTitle,
    courseTitle: lesson.courseTitle,
    courseSlug: lesson.courseSlug,
  };
}

// Students with a current Enrollment on the course, minus the sender.
function currentStudents(db: Queryable, courseId: number, senderId: number) {
  return db
    .select({ id: users.id, name: users.name })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(
      and(eq(enrollments.courseId, courseId), ne(enrollments.userId, senderId))
    )
    .orderBy(users.name)
    .all();
}

// Lapsed Students: Students with progress on the course's lessons but no
// Enrollment (GLOSSARY.md). Staff with progress aren't Students. Lapsed
// Students never get the Announcement.
function lapsedCount(db: Queryable, courseId: number, senderId: number) {
  return (
    db
      .select({ count: sql<number>`count(distinct ${lessonProgress.userId})` })
      .from(lessonProgress)
      .innerJoin(
        users,
        and(
          eq(users.id, lessonProgress.userId),
          eq(users.role, UserRole.Student)
        )
      )
      .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .leftJoin(
        enrollments,
        and(
          eq(enrollments.userId, lessonProgress.userId),
          eq(enrollments.courseId, courseId)
        )
      )
      .where(
        and(
          eq(modules.courseId, courseId),
          isNull(enrollments.id),
          ne(lessonProgress.userId, senderId)
        )
      )
      .get()?.count ?? 0
  );
}

// The lock-screen push for an Announcement. It says only what and where,
// never the note (PRD #12, "Push content and privacy"). The review step
// previews it, and push delivery (#22) sends it.
export function announcementPushText(
  subjectTitle: string,
  courseTitle: string
): { title: string; body: string } {
  return {
    title: `New Announcement: ${subjectTitle} · ${courseTitle}`,
    body: "",
  };
}

export type AnnouncementPreview = {
  ok: true;
  recipients: { id: number; name: string }[];
  lapsedCount: number;
  // The latest earlier Announcement of the same lesson or quiz, if any.
  lastAnnounced: { sentAt: string; reachedCount: number } | null;
  bellRow: { title: string; snippet: string };
  push: { title: string; body: string };
};

// The review step: who it reaches, who is left out, and what they'll see.
export function previewAnnouncement(
  db: Db,
  input: SendAnnouncementInput
): AnnouncementPreview | Failure {
  const target = resolveTarget(db, input.courseId, input.target);
  if (!target) {
    return {
      ok: false,
      status: 404,
      error: "That lesson or quiz isn't on this course.",
    };
  }
  const sender = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.senderId))
    .get();
  const note = input.note?.trim() || null;

  const last = db
    .select({
      sentAt: announcements.sentAt,
      reachedCount: announcements.reachedCount,
    })
    .from(announcements)
    .where(
      and(
        eq(announcements.courseId, input.courseId),
        eq(announcements.lessonId, input.target.lessonId),
        eq(announcements.targetKind, input.target.kind)
      )
    )
    .orderBy(desc(announcements.sentAt), desc(announcements.id))
    .get();

  return {
    ok: true,
    recipients: currentStudents(db, input.courseId, input.senderId),
    lapsedCount: lapsedCount(db, input.courseId, input.senderId),
    lastAnnounced: last ?? null,
    bellRow: {
      title: announcementBellTitle(
        sender?.name ?? "",
        input.target.kind,
        target.subjectTitle
      ),
      snippet: note ?? target.courseTitle,
    },
    push: announcementPushText(target.subjectTitle, target.courseTitle),
  };
}

export type SendAnnouncementInput = {
  courseId: number;
  senderId: number;
  target: AnnouncementTarget;
  note: string | null;
};

export type SendAnnouncementResult =
  | {
      ok: true;
      announcementId: number;
      reachedCount: number;
      pushMessages: PushMessage[];
    }
  | Failure;

// Stores the Announcement and records the event. Access (the course's own
// Instructor, or a Platform Admin) is checked by the route.
export function sendAnnouncement(
  db: Db,
  input: SendAnnouncementInput,
  now: Date
): SendAnnouncementResult {
  const note = input.note?.trim() || null;
  if (note !== null && note.length > ANNOUNCEMENT_NOTE_MAX) {
    return {
      ok: false,
      status: 400,
      error: `The note can be at most ${ANNOUNCEMENT_NOTE_MAX} characters.`,
    };
  }
  if (!resolveTarget(db, input.courseId, input.target)) {
    return {
      ok: false,
      status: 404,
      error: "That lesson or quiz isn't on this course.",
    };
  }

  const reachedCount = currentStudents(
    db,
    input.courseId,
    input.senderId
  ).length;
  const announcementId = db
    .insert(announcements)
    .values({
      courseId: input.courseId,
      senderId: input.senderId,
      targetKind: input.target.kind,
      lessonId: input.target.lessonId,
      note,
      sentAt: now.toISOString(),
      reachedCount,
    })
    .returning({ id: announcements.id })
    .get().id;

  const { pushMessages } = recordNotificationEvent(
    db,
    { type: "announcement_sent", announcementId },
    now
  );
  return { ok: true, announcementId, reachedCount, pushMessages };
}

export type SentAnnouncement = {
  id: number;
  targetKind: AnnouncementTargetKind;
  lessonId: number;
  // The lesson's or quiz's current title.
  subjectTitle: string;
  note: string | null;
  sentAt: string;
  reachedCount: number;
};

// Every Announcement on the course, newest first.
export function listAnnouncements(
  db: Db,
  courseId: number
): SentAnnouncement[] {
  return db
    .select({
      id: announcements.id,
      targetKind: announcements.targetKind,
      lessonId: announcements.lessonId,
      lessonTitle: lessons.title,
      quizTitle: quizzes.title,
      note: announcements.note,
      sentAt: announcements.sentAt,
      reachedCount: announcements.reachedCount,
    })
    .from(announcements)
    .innerJoin(lessons, eq(lessons.id, announcements.lessonId))
    .leftJoin(quizzes, eq(quizzes.lessonId, announcements.lessonId))
    .where(eq(announcements.courseId, courseId))
    .orderBy(desc(announcements.sentAt), desc(announcements.id))
    .all()
    .map(({ lessonTitle, quizTitle, ...row }) => ({
      ...row,
      subjectTitle:
        row.targetKind === AnnouncementTargetKind.Quiz
          ? (quizTitle ?? `Quiz on ${lessonTitle}`)
          : lessonTitle,
    }));
}

function recordAnnouncement(
  db: Db,
  announcementId: number,
  now: Date
): RecordResult {
  const row = db
    .select({
      courseId: announcements.courseId,
      senderId: announcements.senderId,
      targetKind: announcements.targetKind,
      lessonId: announcements.lessonId,
      note: announcements.note,
      senderName: users.name,
    })
    .from(announcements)
    .innerJoin(users, eq(users.id, announcements.senderId))
    .where(eq(announcements.id, announcementId))
    .get();
  if (!row) return { pushMessages: [] };

  const target = resolveTarget(db, row.courseId, {
    kind: row.targetKind,
    lessonId: row.lessonId,
  });
  if (!target) return { pushMessages: [] };

  const recipients = currentStudents(db, row.courseId, row.senderId);

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    for (const recipient of recipients) {
      const push = notify(
        tx,
        {
          recipientId: recipient.id,
          type: NotificationType.Announcement,
          bundleKey: null,
          actorName: row.senderName,
          courseTitle: target.courseTitle,
          subjectTitle: target.subjectTitle,
          detail: row.targetKind,
          note: row.note,
          destinationUrl: `/courses/${target.courseSlug}/lessons/${row.lessonId}`,
        },
        {
          kind: NotificationSourceKind.Announcement,
          id: announcementId,
          lessonId: row.lessonId,
        },
        now
      );
      if (push) pushMessages.push(push);
    }
  });

  return { pushMessages };
}

// ─── Deleted sources (#19) ───
// The bell never points at something that's gone. Each row loses one event
// per deleted source, and disappears at zero. Edits are never events.
//
// Lessons, quizzes and modules are hard-deleted: record those *before* the
// delete, so a module's lessons can still be found. Comments are
// soft-deleted: record after.

export type SourceDeletedEvent =
  | { type: "comment_deleted"; commentId: number }
  | { type: "lesson_deleted"; lessonId: number }
  | { type: "quiz_deleted"; lessonId: number }
  | { type: "module_deleted"; moduleId: number };

export type HardDeleteEvent = Exclude<
  SourceDeletedEvent,
  { type: "comment_deleted" }
>;

// Hard-deletes a lesson, quiz or module and cleans up the bell in one
// transaction: the cleanup runs first, while the module's lessons can still
// be found, and if the delete throws nothing is removed.
export function deleteWithNotifications<T>(
  db: Db,
  event: HardDeleteEvent,
  hardDelete: (tx: Tx) => T
): T {
  return db.transaction((tx) => {
    removeDeletedSource(tx, event);
    return hardDelete(tx);
  });
}

function recordSourceDeleted(db: Db, event: SourceDeletedEvent): RecordResult {
  db.transaction((tx) => removeDeletedSource(tx, event));
  return { pushMessages: [] };
}

function removeDeletedSource(tx: Tx, event: SourceDeletedEvent) {
  {
    switch (event.type) {
      case "comment_deleted":
        removeSources(
          tx,
          and(
            eq(notificationSources.sourceKind, NotificationSourceKind.Comment),
            eq(notificationSources.sourceId, event.commentId)
          )
        );
        break;
      case "lesson_deleted":
        removeLessons(tx, [event.lessonId]);
        break;
      case "module_deleted":
        removeLessons(
          tx,
          tx
            .select({ id: lessons.id })
            .from(lessons)
            .where(eq(lessons.moduleId, event.moduleId))
            .all()
            .map((l) => l.id)
        );
        break;
      case "quiz_deleted":
        removeAnnouncements(
          tx,
          and(
            eq(announcements.lessonId, event.lessonId),
            eq(announcements.targetKind, AnnouncementTargetKind.Quiz)
          )
        );
        break;
    }
  }
}

// Everything under the lessons: comment rows and Announcements (lesson and
// quiz) with their rows. Sources carry their lessonId, so this works even
// after the comments are gone.
function removeLessons(tx: Tx, lessonIds: number[]) {
  if (lessonIds.length === 0) return;
  removeSources(tx, inArray(notificationSources.lessonId, lessonIds));
  removeAnnouncements(tx, inArray(announcements.lessonId, lessonIds));
}

function removeAnnouncements(tx: Tx, where: SQL | undefined) {
  const ids = tx
    .delete(announcements)
    .where(where)
    .returning({ id: announcements.id })
    .all()
    .map((a) => a.id);
  if (ids.length === 0) return;
  removeSources(
    tx,
    and(
      eq(notificationSources.sourceKind, NotificationSourceKind.Announcement),
      inArray(notificationSources.sourceId, ids)
    )
  );
}

// ─── Retention (#19) ───
// Rows older than 90 days go, read or unread. Runs on every recorded event
// instead of on a schedule; createdAt is indexed, so it's cheap. Sources go
// with their row (ON DELETE CASCADE).

export const RETENTION_DAYS = 90;

function deleteExpiredNotifications(db: Db, now: Date) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  db.delete(notifications)
    .where(lt(notifications.createdAt, cutoff.toISOString()))
    .run();
}

// Drops the matching sources, lowers each affected row's count by the number
// it lost, and deletes rows left at zero.
function removeSources(tx: Tx, where: SQL | undefined) {
  const removed = tx
    .delete(notificationSources)
    .where(where)
    .returning({ notificationId: notificationSources.notificationId })
    .all();

  const lost = new Map<number, number>();
  for (const { notificationId } of removed) {
    lost.set(notificationId, (lost.get(notificationId) ?? 0) + 1);
  }
  for (const [notificationId, count] of lost) {
    tx.update(notifications)
      .set({ eventCount: sql`${notifications.eventCount} - ${count}` })
      .where(eq(notifications.id, notificationId))
      .run();
  }
  if (lost.size === 0) return;

  tx.delete(notifications)
    .where(
      and(
        inArray(notifications.id, [...lost.keys()]),
        lte(notifications.eventCount, 0)
      )
    )
    .run();
  // A surviving row keeps its original wording: only its count changes.
}
