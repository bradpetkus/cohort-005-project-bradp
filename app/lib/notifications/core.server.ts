import { and, eq, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  notifications,
  notificationSources,
  pushPreferences,
  pushSubscriptions,
  NotificationSourceKind,
  NotificationType,
  PushEventType,
} from "~/db/schema";
import {
  displayRow,
  type DetailFor,
  type NotificationRow,
} from "./display.server";

// ─── Core ───
// Shared by every kind of event: creating and merging bell rows, the channel
// decision, retention, and dropping deleted sources.
//
// Every function takes the database first and, where time matters, an
// explicit `now` last, so tests can pass an in-memory database and a fixed
// time. Push is never sent from here: recording an event *returns* the push
// messages to deliver, the way refund functions return an Email.

export type Db = BetterSQLite3Database<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Queryable = Db | Tx;

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

export function noPush(): RecordResult {
  return { pushMessages: [] };
}

// ─── Creating and merging bell rows ───

type CommonFields = {
  recipientId: number;
  // Null for types that never bundle.
  bundleKey: string | null;
  actorName: string | null;
  courseTitle: string | null;
  subjectTitle: string | null;
  note: string | null;
  destinationUrl: string;
};

// A row's fields, with `detail` typed for its Notification type.
export type BellRowFields = {
  [T in NotificationType]: CommonFields & { type: T; detail: DetailFor[T] };
}[NotificationType];

export type Source = {
  kind: NotificationSourceKind;
  id: number;
  lessonId: number | null;
};

// Merges into the recipient's unread row with the same bundle key, moving it
// to the top and its display fields to the latest event, or starts a new row.
// Returns the push message for this event, or null when it isn't pushed (see
// shouldPush). A pushed event sets the row's 📱 flag.
export function addToBell(
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
    ...displayRow(row).push,
    tag: row.bundleKey ?? `notification:${row.id}`,
    url: row.destinationUrl,
  };
}

// ─── Retention (#19) ───
// Rows older than 90 days go, read or unread. Runs on every recorded event
// instead of on a schedule; createdAt is indexed, so it's cheap. Sources go
// with their row (ON DELETE CASCADE).

export const RETENTION_DAYS = 90;

export function deleteExpiredNotifications(db: Db, now: Date) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  db.delete(notifications)
    .where(lt(notifications.createdAt, cutoff.toISOString()))
    .run();
}

// ─── Dropping sources ───

// Drops the matching sources, lowers each affected row's count by the number
// it lost, and deletes rows left at zero. A surviving row keeps its original
// wording: only its count changes.
export function removeSources(tx: Queryable, where: SQL | undefined) {
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
}
