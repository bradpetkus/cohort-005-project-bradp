// ─── Notifications ───
// The only place that knows notification rules: who hears about an event,
// bundling, and the bell. See GLOSSARY.md (Notification, Announcement) and
// PRD #12.
//
// This is the public entry point. The rules live in ./notifications/, split
// by kind of event: core (bell rows, channel, retention), display (how each
// type reads), bell, comments, push, refunds, business, announcements and
// deletion.

import {
  deleteExpiredNotifications,
  type Db,
  type RecordResult,
} from "./notifications/core.server";
import {
  recordQuestion,
  recordReply,
  type CommentEvent,
} from "./notifications/comments.server";
import {
  recordAnnouncement,
  type AnnouncementEvent,
} from "./notifications/announcements.server";
import {
  recordBusinessEvent,
  type BusinessEvent,
} from "./notifications/business.server";
import {
  recordRefundDecided,
  recordRefundRequested,
  type RefundNotificationEvent,
} from "./notifications/refunds.server";
import {
  recordSourceDeleted,
  type SourceDeletedEvent,
} from "./notifications/deletion.server";

// ─── Domain events ───

export type NotificationEvent =
  | CommentEvent
  | AnnouncementEvent
  | BusinessEvent
  | RefundNotificationEvent
  | SourceDeletedEvent;

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

export {
  RETENTION_DAYS,
  type Db,
  type PushMessage,
  type Queryable,
  type RecordResult,
  type Tx,
} from "./notifications/core.server";
export { announcementPushText } from "./notifications/display.server";
export {
  BELL_LIMIT,
  getUnreadCount,
  listBell,
  markAllNotificationsRead,
  markNotificationRead,
  type BellRow,
} from "./notifications/bell.server";
export {
  deliverPushMessages,
  getPushPreferences,
  getPushSettings,
  listPushDevices,
  removePushSubscription,
  savePushSubscription,
  setPushPreference,
  testPushMessage,
  type DeliveryReport,
  type NewPushSubscription,
  type PushDevice,
  type PushPreferences,
  type PushSettings,
} from "./notifications/push.server";
export { pushEventTypesFor } from "~/lib/push";
export type { RefundNotificationEvent } from "./notifications/refunds.server";
export type { BusinessEvent } from "./notifications/business.server";
export {
  ANNOUNCEMENT_NOTE_MAX,
  listAnnouncements,
  previewAnnouncement,
  sendAnnouncement,
  type AnnouncementPreview,
  type AnnouncementTarget,
  type SendAnnouncementInput,
  type SendAnnouncementResult,
  type SentAnnouncement,
} from "./notifications/announcements.server";
export {
  deleteWithNotifications,
  type HardDeleteEvent,
  type SourceDeletedEvent,
} from "./notifications/deletion.server";
