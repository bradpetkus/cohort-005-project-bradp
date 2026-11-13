import { and, eq } from "drizzle-orm";
import {
  coupons,
  courses,
  enrollments,
  notificationSources,
  purchases,
  users,
  NotificationSourceKind,
  NotificationType,
  UserRole,
} from "~/db/schema";
import { addToBell, noPush, type Db, type RecordResult } from "./core.server";
import type { EnrollmentVia } from "./display.server";

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
      via: EnrollmentVia;
    }
  | { type: "seat_claimed"; seatId: number };

export function recordBusinessEvent(
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
  return noPush();
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

  addToBell(
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
  via: EnrollmentVia,
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

  // The source is the Enrollment, but an Enrollment ending never touches the
  // row: the bundled count is a record of who joined.
  addToBell(
    db,
    {
      recipientId: enrollment.instructorId,
      type: NotificationType.EnrollmentGained,
      bundleKey: `course_students:${enrollment.courseId}`,
      actorName: enrollment.actorName,
      courseTitle: enrollment.courseTitle,
      subjectTitle: null,
      detail: via,
      note: null,
      destinationUrl: `/instructor/${enrollment.courseId}/students`,
    },
    {
      kind: NotificationSourceKind.Enrollment,
      id: enrollment.id,
      lessonId: null,
    },
    now
  );
}

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
      addToBell(
        tx,
        {
          recipientId: admin.id,
          type: NotificationType.Purchase,
          bundleKey: "purchases",
          actorName: purchase.actorName,
          courseTitle: purchase.courseTitle,
          subjectTitle: null,
          detail: isTeamLicence ? "team_licence" : null,
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
