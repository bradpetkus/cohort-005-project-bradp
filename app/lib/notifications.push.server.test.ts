import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { AnnouncementTargetKind, PushEventType, UserRole } from "~/db/schema";
import {
  listBell,
  previewAnnouncement,
  recordNotificationEvent,
  sendAnnouncement,
  savePushSubscription,
  setPushPreference,
} from "./notifications.server";
import {
  approveRefundRequest,
  declineRefundRequest,
  raiseRefundRequest,
} from "./refunds.server";

// Phone push for questions, Announcements and Refund Requests (#22).

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 4", position: 1 })
    .returning()
    .get().id;
});

function addUser(name: string, role: UserRole = UserRole.Student) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function addDevice(userId: number) {
  savePushSubscription(
    db,
    userId,
    {
      endpoint: `https://push.example.com/${userId}/${Math.random()}`,
      p256dh: "p256dh-key",
      auth: "auth-secret",
      deviceName: "Chrome on Android",
    },
    NOW
  );
}

// What the lesson page does: post a top-level comment, record the question.
function ask(userId: number, body = "secret question text", when = NOW) {
  const comment = db
    .insert(schema.comments)
    .values({ lessonId, userId, parentId: null, body })
    .returning()
    .get();
  return recordNotificationEvent(
    db,
    { type: "new_question", commentId: comment.id },
    when
  );
}

describe("pushing new questions", () => {
  it("pushes to the Instructor with the lesson bundle's tag, never the comment text", () => {
    addDevice(base.instructor.id);

    const first = ask(addUser("Sam").id);
    const second = ask(addUser("Ana").id, "another secret", minutesAfter(1));

    expect(first.pushMessages).toEqual([
      {
        userId: base.instructor.id,
        title: "Sam asked a question on Lesson 4",
        body: "Test Course",
        tag: `lesson:${lessonId}`,
        url: "/instructor/questions",
      },
    ]);
    expect(second.pushMessages).toEqual([
      expect.objectContaining({
        title: "2 new questions on Lesson 4",
        tag: `lesson:${lessonId}`,
      }),
    ]);
    expect(listBell(db, base.instructor.id)[0].pushed).toBe(true);
    expect(JSON.stringify([first, second])).not.toContain("secret");
  });

  it("doesn't push when the Instructor muted questions or has no device", () => {
    expect(ask(addUser("Sam").id).pushMessages).toEqual([]);

    addDevice(base.instructor.id);
    setPushPreference(db, base.instructor.id, PushEventType.Question, false);

    expect(ask(addUser("Ana").id).pushMessages).toEqual([]);
    expect(listBell(db, base.instructor.id)[0].pushed).toBe(false);
  });
});

function enroll(userId: number) {
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function announce(note: string | null = "secret note", when = NOW) {
  const input = {
    courseId: base.course.id,
    senderId: base.instructor.id,
    target: { kind: AnnouncementTargetKind.Lesson, lessonId },
    note,
  };
  const result = sendAnnouncement(db, input, when);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("pushing Announcements", () => {
  it("pushes to each Student with a device the text the review step previewed, never the note", () => {
    const sam = addUser("Sam");
    const ana = addUser("Ana");
    enroll(sam.id);
    enroll(ana.id);
    addDevice(sam.id);
    addDevice(ana.id);
    setPushPreference(db, ana.id, PushEventType.Announcement, false);
    const preview = previewAnnouncement(db, {
      courseId: base.course.id,
      senderId: base.instructor.id,
      target: { kind: AnnouncementTargetKind.Lesson, lessonId },
      note: "secret note",
    });
    if (!preview.ok) throw new Error(preview.error);

    const first = announce();
    const second = announce("another secret", minutesAfter(1));

    expect(first.pushMessages).toEqual([
      {
        userId: sam.id,
        title: "New Announcement: Lesson 4 · Test Course",
        body: "",
        tag: expect.any(String),
        url: `/courses/test-course/lessons/${lessonId}`,
      },
    ]);
    expect(preview.push).toEqual({
      title: first.pushMessages[0].title,
      body: first.pushMessages[0].body,
    });
    expect(second.pushMessages[0].tag).not.toBe(first.pushMessages[0].tag);
    expect(listBell(db, sam.id).map((row) => row.pushed)).toEqual([true, true]);
    expect(listBell(db, ana.id).map((row) => row.pushed)).toEqual([
      false,
      false,
    ]);
    expect(JSON.stringify([first, second])).not.toContain("secret");
  });
});

function buyForSelf(userId: number) {
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId,
      courseId: base.course.id,
      amountPaid: 7900,
      createdAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
    })
    .returning()
    .get();
  enroll(userId);
  return purchase;
}

// What the refund route does: raise, then record the event.
function requestRefund(buyerId: number, when = NOW) {
  const purchase = buyForSelf(buyerId);
  const result = raiseRefundRequest(
    db,
    purchase.id,
    buyerId,
    "secret reason",
    when
  );
  if (!result.ok) throw new Error(result.error);
  return {
    refundRequestId: result.refundRequestId,
    ...recordNotificationEvent(
      db,
      { type: "refund_requested", refundRequestId: result.refundRequestId },
      when
    ),
  };
}

// What the admin refunds route does: decide, then record the event.
function decide(
  refundRequestId: number,
  adminId: number,
  decision: "approved" | "declined",
  when = minutesAfter(5)
) {
  const result =
    decision === "approved"
      ? approveRefundRequest(
          db,
          refundRequestId,
          adminId,
          "secret decision note",
          when
        )
      : declineRefundRequest(
          db,
          refundRequestId,
          adminId,
          "secret decision note",
          when
        );
  if (!result.ok) throw new Error(result.error);
  return recordNotificationEvent(
    db,
    {
      type: "refund_decided",
      refundRequestId,
      decision,
      endedEnrollmentUserIds:
        result.decision === "approved" ? result.endedEnrollmentUserIds : [],
    },
    when
  );
}

describe("pushing Refund Request decisions", () => {
  it("tells the buyer the outcome with a unique tag, never the decision note", () => {
    const pat = addUser("Pat", UserRole.Admin);
    const sam = addUser("Sam");
    addDevice(sam.id);
    addDevice(base.instructor.id);
    const first = requestRefund(sam.id);
    const second = requestRefund(sam.id, minutesAfter(1));

    const approved = decide(first.refundRequestId, pat.id, "approved");
    const declined = decide(second.refundRequestId, pat.id, "declined");

    expect(approved.pushMessages).toEqual([
      {
        userId: sam.id,
        title: "Your Refund Request was approved",
        body: "Test Course",
        tag: expect.any(String),
        url: "/settings",
      },
    ]);
    expect(declined.pushMessages).toEqual([
      expect.objectContaining({ title: "Your Refund Request was declined" }),
    ]);
    expect(declined.pushMessages[0].tag).not.toBe(approved.pushMessages[0].tag);
    expect(JSON.stringify([approved, declined])).not.toContain("secret");
  });

  it("doesn't push when the buyer muted decisions", () => {
    const pat = addUser("Pat", UserRole.Admin);
    const sam = addUser("Sam");
    addDevice(sam.id);
    setPushPreference(db, sam.id, PushEventType.RefundDecision, false);
    const { refundRequestId } = requestRefund(sam.id);

    expect(decide(refundRequestId, pat.id, "declined").pushMessages).toEqual(
      []
    );
    expect(listBell(db, sam.id)[0].pushed).toBe(false);
  });
});

describe("pushing new Refund Requests", () => {
  it("pushes to every Platform Admin with a device, each with its own tag, never the reason", () => {
    const pat = addUser("Pat", UserRole.Admin);
    const quinn = addUser("Quinn", UserRole.Admin);
    const rex = addUser("Rex", UserRole.Admin);
    addDevice(pat.id);
    addDevice(quinn.id);
    setPushPreference(db, quinn.id, PushEventType.RefundRequest, false);

    const first = requestRefund(addUser("Sam").id);
    const second = requestRefund(addUser("Ana").id, minutesAfter(1));

    expect(first.pushMessages).toEqual([
      {
        userId: pat.id,
        title: "Sam requested a refund for Test Course",
        body: "Test Course",
        tag: expect.any(String),
        url: "/admin/refunds",
      },
    ]);
    expect(second.pushMessages.map((m) => m.userId)).toEqual([pat.id]);
    expect(second.pushMessages[0].tag).not.toBe(first.pushMessages[0].tag);
    expect(listBell(db, pat.id).map((row) => row.pushed)).toEqual([true, true]);
    expect(listBell(db, rex.id).map((row) => row.pushed)).toEqual([
      false,
      false,
    ]);
    expect(JSON.stringify([first, second])).not.toContain("secret");
  });
});

describe("in-app-only events", () => {
  it("never push Purchases, Enrollments or Seats, even to people with devices", () => {
    const pat = addUser("Pat", UserRole.Admin);
    const tia = addUser("Tia");
    const sam = addUser("Sam");
    for (const person of [pat, tia, base.instructor]) addDevice(person.id);
    const purchase = buyForSelf(sam.id);
    const team = db.insert(schema.teams).values({}).returning().get();
    const teamPurchase = db
      .insert(schema.purchases)
      .values({ userId: tia.id, courseId: base.course.id, amountPaid: 7900 })
      .returning()
      .get();
    const seat = db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: "SEAT-1",
        purchaseId: teamPurchase.id,
        redeemedByUserId: addUser("Lee").id,
        redeemedAt: NOW.toISOString(),
      })
      .returning()
      .get();

    const results = [
      recordNotificationEvent(
        db,
        { type: "purchase_made", purchaseId: purchase.id },
        NOW
      ),
      recordNotificationEvent(
        db,
        {
          type: "enrollment_gained",
          userId: sam.id,
          courseId: base.course.id,
          via: "purchase",
        },
        NOW
      ),
      recordNotificationEvent(
        db,
        { type: "seat_claimed", seatId: seat.id },
        NOW
      ),
    ];

    expect(results.flatMap((r) => r.pushMessages)).toEqual([]);
    for (const person of [pat, tia, base.instructor]) {
      expect(listBell(db, person.id)[0]).toMatchObject({ pushed: false });
    }
  });
});
