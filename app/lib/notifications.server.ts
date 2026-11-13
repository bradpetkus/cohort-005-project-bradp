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
  pushPreferences,
  pushSubscriptions,
  users,
  NotificationSourceKind,
  NotificationType,
  PushEventType,
} from "~/db/schema";
import { defaultPushTransport, type PushTransport } from "~/lib/push.server";

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

export type NotificationEvent = {
  type: "comment_reply";
  commentId: number;
};

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
  switch (event.type) {
    case "comment_reply":
      return recordReply(db, event.commentId, now);
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
// type is in-app only. Types not switched to push yet are null too, so
// switching one on is a one-line change here.
const PUSH_EVENT_FOR: Record<NotificationType, PushEventType | null> = {
  [NotificationType.Reply]: PushEventType.Reply,
  [NotificationType.Question]: null,
  [NotificationType.Announcement]: null,
  [NotificationType.RefundDecision]: null,
  [NotificationType.RefundRequest]: null,
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

// Lock-screen text says only what happened and where: the bell title and the
// course. It never includes comment text or notes. The tag is the bundle key,
// so a bundle replaces its earlier push, or else a key unique to the row.
function pushMessageFor(row: NotificationRow): PushMessage {
  return {
    userId: row.recipientId,
    title: titleFor(row),
    body: row.courseTitle ?? "",
    tag: row.bundleKey ?? `notification:${row.id}`,
    url: row.destinationUrl,
  };
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

export type DeliveryReport = { delivered: number; gone: number; failed: number };

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
