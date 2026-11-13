import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  approveRefundRequest,
  declineRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";
import {
  getUnreadCount,
  listBell,
  recordNotificationEvent,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function daysBefore(days: number) {
  const when = new Date(NOW);
  when.setDate(when.getDate() - days);
  return when.toISOString();
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let pat: typeof schema.users.$inferSelect;
let quinn: typeof schema.users.$inferSelect;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
  pat = addUser("Pat", UserRole.Admin);
  quinn = addUser("Quinn", UserRole.Admin);
});

function addUser(name: string, role: UserRole = UserRole.Student) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function buyForSelf(userId: number) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: daysBefore(3),
    })
    .returning()
    .get();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
  return purchase;
}

function buySeats(userId: number, seats: number) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900 * seats,
      createdAt: daysBefore(3),
    })
    .returning()
    .get();
  const seatRows = Array.from({ length: seats }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
  return { purchase, seats: seatRows };
}

function claimSeat(seatId: number, userId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: daysBefore(1) })
    .where(eq(schema.coupons.id, seatId))
    .run();
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

// What the refund route does: raise, then record the event.
function requestRefund(purchaseId: number, buyerId: number, when = NOW) {
  const result = raiseRefundRequest(
    db,
    purchaseId,
    buyerId,
    "Not for me",
    when
  );
  if (!result.ok) throw new Error(result.error);
  recordNotificationEvent(
    db,
    { type: "refund_requested", refundRequestId: result.refundRequestId },
    when
  );
  return result.refundRequestId;
}

describe("a new Refund Request", () => {
  it("gives every Platform Admin their own row linking to the refunds page", () => {
    const purchase = buyForSelf(base.user.id);

    requestRefund(purchase.id, base.user.id);

    for (const admin of [pat, quinn]) {
      expect(listBell(db, admin.id)).toEqual([
        expect.objectContaining({
          type: "refund_request",
          title: "Test User requested a refund for Test Course",
          unread: true,
          url: "/admin/refunds",
        }),
      ]);
    }
    expect(listBell(db, base.user.id)).toEqual([]);
  });

  it("never bundles: each Refund Request is its own row", () => {
    const ana = addUser("Ana");
    requestRefund(buyForSelf(base.user.id).id, base.user.id);
    requestRefund(buyForSelf(ana.id).id, ana.id, minutesAfter(1));

    expect(listBell(db, pat.id).map((row) => row.title)).toEqual([
      "Ana requested a refund for Test Course",
      "Test User requested a refund for Test Course",
    ]);
    expect(getUnreadCount(db, pat.id)).toBe(2);
  });

  it("never notifies a Platform Admin about their own Refund Request", () => {
    requestRefund(buyForSelf(pat.id).id, pat.id);

    expect(listBell(db, pat.id)).toEqual([]);
    expect(listBell(db, quinn.id)).toHaveLength(1);
  });
});

// What the admin refunds route does: decide, then record the event.
function approve(
  refundRequestId: number,
  adminId: number,
  note: string | null,
  when = NOW
) {
  const result = approveRefundRequest(db, refundRequestId, adminId, note, when);
  if (!result.ok) throw new Error(result.error);
  recordNotificationEvent(
    db,
    {
      type: "refund_decided",
      refundRequestId,
      decision: "approved",
      enrollmentEnded: result.enrollmentEnded,
    },
    when
  );
}

function decline(
  refundRequestId: number,
  adminId: number,
  note: string,
  when = NOW
) {
  const result = declineRefundRequest(db, refundRequestId, adminId, note, when);
  if (!result.ok) throw new Error(result.error);
  recordNotificationEvent(
    db,
    {
      type: "refund_decided",
      refundRequestId,
      decision: "declined",
      enrollmentEnded: false,
    },
    when
  );
}

describe("a decided Refund Request", () => {
  it("tells a Student buyer it was approved, with the decision note", () => {
    const id = requestRefund(buyForSelf(base.user.id).id, base.user.id);

    approve(id, pat.id, "Sorry it wasn't a fit.", minutesAfter(5));

    expect(listBell(db, base.user.id)).toEqual([
      expect.objectContaining({
        type: "refund_decision",
        title: "Your Refund Request for Test Course was approved",
        snippet: "Sorry it wasn't a fit.",
        unread: true,
        url: "/settings",
      }),
    ]);
  });

  it("tells a Team Admin buyer it was declined, linking to the team page", () => {
    const priya = addUser("Priya");
    const { purchase } = buySeats(priya.id, 2);
    const id = requestRefund(purchase.id, priya.id);

    decline(id, pat.id, "Seats were already handed out.", minutesAfter(5));

    expect(listBell(db, priya.id)).toEqual([
      expect.objectContaining({
        title: "Your Refund Request for Test Course was declined",
        snippet: "Seats were already handed out.",
        url: "/team",
      }),
    ]);
  });

  it("marks the other Platform Admins' row for it read", () => {
    const rex = addUser("Rex", UserRole.Admin);
    const ana = addUser("Ana");
    const decided = requestRefund(buyForSelf(base.user.id).id, base.user.id);
    requestRefund(buyForSelf(ana.id).id, ana.id, minutesAfter(1));

    approve(decided, pat.id, null, minutesAfter(5));

    for (const admin of [quinn, rex]) {
      expect(listBell(db, admin.id)).toEqual([
        expect.objectContaining({
          title: "Ana requested a refund for Test Course",
          unread: true,
        }),
        expect.objectContaining({
          title: "Test User requested a refund for Test Course",
          unread: false,
        }),
      ]);
      expect(getUnreadCount(db, admin.id)).toBe(1);
    }
  });
});

describe("an Enrollment ended by an approved Refund Request", () => {
  it("tells the course's Instructor who left", () => {
    const id = requestRefund(buyForSelf(base.user.id).id, base.user.id);

    approve(id, pat.id, null, minutesAfter(5));

    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        type: "enrollment_ended",
        title: "Test User left Test Course after a refund",
        unread: true,
        url: `/instructor/${base.course.id}/students`,
      }),
    ]);
  });

  it("tells no one when the buyer keeps the Enrollment through a Claimed Seat", () => {
    const priya = addUser("Priya");
    const { seats } = buySeats(priya.id, 2);
    claimSeat(seats[0].id, base.user.id);
    const purchase = db
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid: 7900,
        createdAt: daysBefore(2),
      })
      .returning()
      .get();
    const id = requestRefund(purchase.id, base.user.id);

    approve(id, pat.id, null, minutesAfter(5));

    expect(listBell(db, base.instructor.id)).toEqual([]);
  });

  it("tells no one when the Refund Request is declined", () => {
    const id = requestRefund(buyForSelf(base.user.id).id, base.user.id);

    decline(id, pat.id, "Outside the rules.", minutesAfter(5));

    expect(listBell(db, base.instructor.id)).toEqual([]);
  });
});

describe("deciding a Refund Request and ending an Enrollment", () => {
  it("never removes or rewrites an existing Notification", () => {
    const id = requestRefund(buyForSelf(base.user.id).id, base.user.id);
    approve(id, pat.id, "First note", minutesAfter(5));
    const before = {
      buyer: listBell(db, base.user.id),
      instructor: listBell(db, base.instructor.id),
      quinn: listBell(db, quinn.id),
    };

    // A second Refund Request on another Purchase of the same course.
    const again = requestRefund(
      buyForSelf(base.user.id).id,
      base.user.id,
      minutesAfter(10)
    );
    decline(again, quinn.id, "Second note", minutesAfter(15));

    expect(listBell(db, base.user.id).slice(1)).toEqual(before.buyer);
    expect(listBell(db, base.instructor.id)).toEqual(before.instructor);
    expect(listBell(db, quinn.id).slice(1)).toEqual(before.quinn);
  });
});
