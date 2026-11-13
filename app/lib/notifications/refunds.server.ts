import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  coupons,
  courses,
  notifications,
  notificationSources,
  purchases,
  refunds,
  users,
  NotificationSourceKind,
  NotificationType,
  UserRole,
} from "~/db/schema";
import {
  addToBell,
  noPush,
  type Db,
  type PushMessage,
  type RecordResult,
  type Source,
} from "./core.server";
import type { RefundDecisionDetail } from "./display.server";

// ─── Refund Requests ───

export type RefundNotificationEvent =
  | { type: "refund_requested"; refundRequestId: number }
  | {
      type: "refund_decided";
      refundRequestId: number;
      decision: RefundDecisionDetail;
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
export function recordRefundRequested(
  db: Db,
  refundRequestId: number,
  now: Date
): RecordResult {
  const request = getRefundRequest(db, refundRequestId);
  if (!request) return noPush();

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
      const push = addToBell(
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
export function recordRefundDecided(
  db: Db,
  event: Extract<RefundNotificationEvent, { type: "refund_decided" }>,
  now: Date
): RecordResult {
  const request = getRefundRequest(db, event.refundRequestId);
  if (!request) return noPush();

  // A Purchase with Seats is a Team Licence, whose buyer is its Team Admin.
  const isTeamLicence =
    db
      .select({ id: coupons.id })
      .from(coupons)
      .where(eq(coupons.purchaseId, request.purchaseId))
      .get() !== undefined;

  const source: Source = {
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
      const push = addToBell(
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
      addToBell(
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
