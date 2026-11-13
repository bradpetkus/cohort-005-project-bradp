import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getUnreadCount,
  listBell,
  markAllNotificationsRead,
  recordNotificationEvent,
} from "./notifications.server";

// Business activity: Purchases, Enrollments gained and Seats claimed (#16).

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function addUser(name: string, role = UserRole.Student) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function addCourse(title: string) {
  return db
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/ /g, "-"),
      description: title,
      salesCopy: title,
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

// An Individual Purchase, as the purchase page does it: buy, enroll, record.
function buyForSelf(userId: number, courseId = base.course.id, when = NOW) {
  const purchase = db
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid: 7900 })
    .returning()
    .get();
  const enrollment = db
    .insert(schema.enrollments)
    .values({ userId, courseId })
    .returning()
    .get();
  return [
    recordNotificationEvent(
      db,
      { type: "purchase_made", purchaseId: purchase.id },
      when
    ),
    recordNotificationEvent(
      db,
      { type: "enrollment_gained", enrollmentId: enrollment.id, via: "purchase" },
      when
    ),
  ];
}

// A Team Licence: buy Seats, record the Purchase. The buyer isn't enrolled.
function buySeats(userId: number, seats: number, when = NOW) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({ userId, courseId: base.course.id, amountPaid: 7900 * seats })
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
  const result = recordNotificationEvent(
    db,
    { type: "purchase_made", purchaseId: purchase.id },
    when
  );
  return { purchase, seats: seatRows, result };
}

// Claiming a Seat, as the redeem page does it.
function claimSeat(seatId: number, userId: number, when = NOW) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: userId, redeemedAt: when.toISOString() })
    .where(eq(schema.coupons.id, seatId))
    .run();
  const enrollment = db
    .insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .returning()
    .get();
  return [
    recordNotificationEvent(db, { type: "seat_claimed", seatId }, when),
    recordNotificationEvent(
      db,
      { type: "enrollment_gained", enrollmentId: enrollment.id, via: "seat" },
      when
    ),
  ];
}

describe("a new Purchase", () => {
  it("notifies every Platform Admin but not the buyer", () => {
    const admin1 = addUser("Ada", UserRole.Admin);
    const admin2 = addUser("Bea", UserRole.Admin);
    const ana = addUser("Ana");

    buyForSelf(ana.id);

    for (const admin of [admin1, admin2]) {
      expect(listBell(db, admin.id)).toEqual([
        expect.objectContaining({
          type: "purchase",
          title: "Ana bought Test Course",
          unread: true,
          url: "/admin/courses",
        }),
      ]);
    }
    expect(listBell(db, ana.id)).toEqual([]);
  });

  it("names a Team Licence Purchase", () => {
    const admin = addUser("Ada", UserRole.Admin);
    const tia = addUser("Tia");

    buySeats(tia.id, 5);

    expect(listBell(db, admin.id)).toEqual([
      expect.objectContaining({
        title: "Tia bought a Team Licence for Test Course",
      }),
    ]);
  });

  it("merges Purchases of any course and kind into one unread row per admin", () => {
    const admin = addUser("Ada", UserRole.Admin);
    const other = addCourse("Other Course");
    buyForSelf(addUser("Ana").id);
    buySeats(addUser("Tia").id, 3, minutesAfter(1));
    buyForSelf(addUser("Bo").id, other.id, minutesAfter(2));

    expect(listBell(db, admin.id)).toEqual([
      expect.objectContaining({
        title: "3 new Purchases",
        lastEventAt: minutesAfter(2).toISOString(),
        url: "/admin/courses",
        unread: true,
      }),
    ]);
    expect(getUnreadCount(db, admin.id)).toBe(1);
  });

  it("starts a fresh row once the admin has read the bundle", () => {
    const admin = addUser("Ada", UserRole.Admin);
    buyForSelf(addUser("Ana").id);
    buyForSelf(addUser("Bo").id);
    markAllNotificationsRead(db, admin.id, minutesAfter(1));

    buyForSelf(addUser("Cy").id, base.course.id, minutesAfter(2));

    expect(listBell(db, admin.id).map((row) => row.title)).toEqual([
      "Cy bought Test Course",
      "2 new Purchases",
    ]);
  });

  it("never pushes", () => {
    const admin = addUser("Ada", UserRole.Admin);

    const results = [
      ...buyForSelf(addUser("Ana").id),
      buySeats(addUser("Tia").id, 2).result,
    ];

    expect(results.flatMap((r) => r.pushMessages)).toEqual([]);
    expect(listBell(db, admin.id)[0].pushed).toBe(false);
  });
});

describe("an Enrollment gained", () => {
  it("notifies the course's Instructor, by Individual Purchase or Claimed Seat", () => {
    buyForSelf(addUser("Ana").id);

    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        type: "enrollment_gained",
        title: "Ana enrolled in Test Course",
        unread: true,
        url: `/instructor/${base.course.id}/students`,
      }),
    ]);
  });

  it("merges new Students per course", () => {
    const other = addCourse("Other Course");
    const tia = addUser("Tia");
    const { seats } = buySeats(tia.id, 2);
    buyForSelf(addUser("Ana").id);
    claimSeat(seats[0].id, addUser("Bo").id, minutesAfter(1));
    buyForSelf(addUser("Cy").id, other.id, minutesAfter(2));
    claimSeat(seats[1].id, addUser("Di").id, minutesAfter(3));

    expect(
      listBell(db, base.instructor.id).map((row) => [row.title, row.url])
    ).toEqual([
      [
        "3 new Students on Test Course",
        `/instructor/${base.course.id}/students`,
      ],
      ["Cy enrolled in Other Course", `/instructor/${other.id}/students`],
    ]);
  });

  it("never counts an Enrollment that was already counted", () => {
    const ana = addUser("Ana");
    buyForSelf(ana.id);
    const [enrollment] = db
      .select({ id: schema.enrollments.id })
      .from(schema.enrollments)
      .where(eq(schema.enrollments.userId, ana.id))
      .all();

    // The same Enrollment reported again: Ana is not a new Student.
    recordNotificationEvent(
      db,
      { type: "enrollment_gained", enrollmentId: enrollment.id, via: "purchase" },
      minutesAfter(1)
    );

    expect(listBell(db, base.instructor.id).map((row) => row.title)).toEqual([
      "Ana enrolled in Test Course",
    ]);
  });

  it("never notifies the Instructor about enrolling themselves", () => {
    buyForSelf(base.instructor.id);

    expect(listBell(db, base.instructor.id)).toEqual([]);
  });

  it("keeps the bundled count when one of those Enrollments later ends", () => {
    const ana = addUser("Ana");
    buyForSelf(ana.id);
    buyForSelf(addUser("Bo").id);
    db.delete(schema.enrollments)
      .where(
        and(
          eq(schema.enrollments.userId, ana.id),
          eq(schema.enrollments.courseId, base.course.id)
        )
      )
      .run();

    expect(listBell(db, base.instructor.id)[0].title).toBe(
      "2 new Students on Test Course"
    );
  });

  it("never pushes", () => {
    const results = buyForSelf(addUser("Ana").id);

    expect(results.flatMap((r) => r.pushMessages)).toEqual([]);
    expect(listBell(db, base.instructor.id)[0].pushed).toBe(false);
  });
});
describe("a Seat claimed", () => {
  it("notifies the Team Licence's buyer", () => {
    const tia = addUser("Tia");
    const { seats } = buySeats(tia.id, 3);

    claimSeat(seats[0].id, addUser("Ana").id);

    expect(listBell(db, tia.id)).toEqual([
      expect.objectContaining({
        type: "seat_claimed",
        title: "Ana claimed a seat on Test Course",
        unread: true,
        url: "/team",
      }),
    ]);
  });

  it("merges claims per Team Licence", () => {
    const tia = addUser("Tia");
    const first = buySeats(tia.id, 3);
    const second = buySeats(tia.id, 1);
    claimSeat(first.seats[0].id, addUser("Ana").id);
    claimSeat(second.seats[0].id, addUser("Bo").id, minutesAfter(1));
    claimSeat(first.seats[1].id, addUser("Cy").id, minutesAfter(2));
    claimSeat(first.seats[2].id, addUser("Di").id, minutesAfter(3));

    expect(listBell(db, tia.id).map((row) => row.title)).toEqual([
      "3 seats claimed on Test Course",
      "Bo claimed a seat on Test Course",
    ]);
  });

  it("never notifies a buyer who claims their own Seat", () => {
    const tia = addUser("Tia");
    const { seats } = buySeats(tia.id, 2);

    claimSeat(seats[0].id, tia.id);

    expect(listBell(db, tia.id)).toEqual([]);
  });

  it("never pushes", () => {
    const tia = addUser("Tia");
    const { seats } = buySeats(tia.id, 2);

    const results = claimSeat(seats[0].id, addUser("Ana").id);

    expect(results.flatMap((r) => r.pushMessages)).toEqual([]);
    expect(listBell(db, tia.id)[0].pushed).toBe(false);
  });
});
