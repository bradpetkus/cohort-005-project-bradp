import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { PushEventType, UserRole } from "~/db/schema";
import {
  getUnreadCount,
  listBell,
  markAllNotificationsRead,
  markNotificationRead,
  deliverPushMessages,
  getPushPreferences,
  listPushDevices,
  pushEventTypesFor,
  recordNotificationEvent,
  removePushSubscription,
  savePushSubscription,
  setPushPreference,
  testPushMessage,
} from "./notifications.server";
import type { PushOutcome, PushPayload, PushTransport } from "./push.server";

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
    .values({ moduleId: module.id, title: "Lesson 3", position: 1 })
    .returning()
    .get().id;
});

function addLearner(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

function postComment(userId: number, body = "What does this do?") {
  return db
    .insert(schema.comments)
    .values({ lessonId, userId, parentId: null, body })
    .returning()
    .get();
}

function reply(
  parentId: number,
  userId: number,
  when = NOW,
  body = "Here is my answer."
) {
  const comment = db
    .insert(schema.comments)
    .values({ lessonId, userId, parentId, body })
    .returning()
    .get();
  return recordNotificationEvent(
    db,
    { type: "comment_reply", commentId: comment.id },
    when
  );
}

describe("a reply in a comment thread", () => {
  it("notifies the thread's top-level author", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);

    reply(question.id, sam.id);

    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({
        type: "reply",
        title: "Sam replied to your comment on Lesson 3",
        unread: true,
        url: `/courses/test-course/lessons/${lessonId}#comment-${question.id}`,
      }),
    ]);
  });

  it("notifies everyone who has already replied, once each", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    reply(question.id, bo.id);
    reply(question.id, bo.id);

    reply(question.id, sam.id);

    expect(listBell(db, bo.id)).toEqual([
      expect.objectContaining({
        title: "Sam replied in a thread you're in on Lesson 3",
      }),
    ]);
  });

  it("never notifies the replier", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    reply(question.id, sam.id);

    reply(question.id, ana.id);
    reply(question.id, sam.id, minutesAfter(1));

    expect(listBell(db, sam.id)).toHaveLength(1);
    expect(listBell(db, ana.id)).toHaveLength(1);
  });

  it("notifies the Instructor who took part in the thread", () => {
    const ana = addLearner("Ana");
    const question = postComment(ana.id);
    reply(question.id, base.instructor.id);

    const sam = addLearner("Sam");
    reply(question.id, sam.id);

    expect(listBell(db, base.instructor.id)).toHaveLength(1);
  });

  it("never stores or shows the comment text", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id, "secret question");

    reply(question.id, sam.id, NOW, "secret answer");

    const [row] = listBell(db, ana.id);
    expect(JSON.stringify(row)).not.toContain("secret");
    expect(row.snippet).toBe("Test Course");
  });

  it("does nothing for a top-level comment", () => {
    const ana = addLearner("Ana");
    const question = postComment(ana.id);

    recordNotificationEvent(
      db,
      { type: "comment_reply", commentId: question.id },
      NOW
    );

    expect(listBell(db, ana.id)).toEqual([]);
    expect(listBell(db, base.instructor.id)).toEqual([]);
  });

});

describe("bundling replies", () => {
  it("merges replies in the same thread into one unread row", () => {
    const ana = addLearner("Ana");
    const question = postComment(ana.id);
    reply(question.id, addLearner("Bo").id);
    reply(question.id, addLearner("Cy").id, minutesAfter(1));
    reply(question.id, addLearner("Sam").id, minutesAfter(2));

    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({
        title: "3 new replies on your comment on Lesson 3",
        lastEventAt: minutesAfter(2).toISOString(),
        unread: true,
      }),
    ]);
    expect(getUnreadCount(db, ana.id)).toBe(1);
  });

  it("starts a fresh row once the bundle has been read", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    reply(question.id, sam.id);
    reply(question.id, sam.id);
    markAllNotificationsRead(db, ana.id, minutesAfter(1));

    reply(question.id, sam.id, minutesAfter(2));

    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({
        title: "Sam replied to your comment on Lesson 3",
        unread: true,
      }),
      expect.objectContaining({
        title: "2 new replies on your comment on Lesson 3",
        unread: false,
      }),
    ]);
  });

  it("keeps different threads in separate rows, latest event first", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const first = postComment(ana.id);
    const second = postComment(ana.id);
    reply(first.id, sam.id);
    reply(second.id, sam.id, minutesAfter(1));

    reply(first.id, sam.id, minutesAfter(2));

    expect(listBell(db, ana.id).map((row) => row.url)).toEqual([
      expect.stringContaining(`#comment-${first.id}`),
      expect.stringContaining(`#comment-${second.id}`),
    ]);
  });
});

describe("the bell", () => {
  function fillBell(recipientId: number, threads: number) {
    const sam = addLearner(`Replier${recipientId}`);
    for (let i = 0; i < threads; i++) {
      const question = postComment(recipientId);
      reply(question.id, sam.id, minutesAfter(i));
    }
  }

  it("shows the newest 30 rows but counts every unread one", () => {
    const ana = addLearner("Ana");
    fillBell(ana.id, 32);

    expect(listBell(db, ana.id)).toHaveLength(30);
    expect(listBell(db, ana.id)[0].lastEventAt).toBe(
      minutesAfter(31).toISOString()
    );
    expect(getUnreadCount(db, ana.id)).toBe(32);
  });

  it("marks one row read", () => {
    const ana = addLearner("Ana");
    fillBell(ana.id, 2);
    const [newest] = listBell(db, ana.id);

    markNotificationRead(db, ana.id, newest.id, minutesAfter(5));

    expect(getUnreadCount(db, ana.id)).toBe(1);
    expect(listBell(db, ana.id)[0]).toMatchObject({
      id: newest.id,
      unread: false,
    });
  });

  it("marks all read, including rows beyond the 30 shown", () => {
    const ana = addLearner("Ana");
    fillBell(ana.id, 32);

    markAllNotificationsRead(db, ana.id, minutesAfter(40));

    expect(getUnreadCount(db, ana.id)).toBe(0);
  });

  it("only reads and marks the person's own Notifications", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    fillBell(ana.id, 1);
    fillBell(bo.id, 1);
    const [anasRow] = listBell(db, ana.id);

    const result = markNotificationRead(db, bo.id, anasRow.id, NOW);
    markAllNotificationsRead(db, bo.id, NOW);

    expect(result).toBeNull();
    expect(getUnreadCount(db, ana.id)).toBe(1);
    expect(listBell(db, bo.id)).toHaveLength(1);
    expect(listBell(db, bo.id)[0].id).not.toBe(anasRow.id);
  });

  it("gives back the row's destination when marking it read", () => {
    const ana = addLearner("Ana");
    fillBell(ana.id, 1);
    const [row] = listBell(db, ana.id);

    expect(markNotificationRead(db, ana.id, row.id, NOW)).toBe(row.url);
  });
});

function addDevice(userId: number, name = "Chrome on Android") {
  const endpoint = `https://push.example.com/${userId}/${Math.random()}`;
  savePushSubscription(
    db,
    userId,
    { endpoint, p256dh: "p256dh-key", auth: "auth-secret", deviceName: name },
    NOW
  );
  return endpoint;
}

describe("pushing replies", () => {
  it("pushes to a recipient with a device and tags the bell row", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    addDevice(ana.id);
    const question = postComment(ana.id);

    const { pushMessages } = reply(question.id, sam.id);

    expect(pushMessages).toEqual([
      {
        userId: ana.id,
        title: "Sam replied to your comment on Lesson 3",
        body: "Test Course",
        tag: `thread:${question.id}`,
        url: `/courses/test-course/lessons/${lessonId}#comment-${question.id}`,
      },
    ]);
    expect(listBell(db, ana.id)[0].pushed).toBe(true);
  });

  it("doesn't push to a recipient with no devices, and leaves the row untagged", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);

    const { pushMessages } = reply(question.id, sam.id);

    expect(pushMessages).toEqual([]);
    expect(listBell(db, ana.id)[0].pushed).toBe(false);
  });

  it("gives a bundled reply the thread's tag and a count, never the comment text", () => {
    const ana = addLearner("Ana");
    addDevice(ana.id);
    const question = postComment(ana.id, "secret question");
    const first = reply(question.id, addLearner("Bo").id, NOW, "secret one");

    const second = reply(
      question.id,
      addLearner("Sam").id,
      minutesAfter(1),
      "secret two"
    );

    expect(first.pushMessages[0].tag).toBe(`thread:${question.id}`);
    expect(second.pushMessages).toEqual([
      expect.objectContaining({
        title: "2 new replies on your comment on Lesson 3",
        tag: `thread:${question.id}`,
      }),
    ]);
    expect(JSON.stringify([first, second])).not.toContain("secret");
  });

  it("doesn't push an event type the person has muted, on any device", () => {
    const ana = addLearner("Ana");
    addDevice(ana.id, "Chrome on Android");
    addDevice(ana.id, "Safari on iPhone");
    setPushPreference(db, ana.id, PushEventType.Reply, false);
    const question = postComment(ana.id);

    const { pushMessages } = reply(question.id, addLearner("Sam").id);

    expect(pushMessages).toEqual([]);
    expect(listBell(db, ana.id)[0]).toMatchObject({ unread: true, pushed: false });
  });
});

// Records every send and answers "gone" or "failed" for chosen endpoints.
function fakeTransport(answers: Record<string, PushOutcome | "throw"> = {}) {
  const sent: { endpoint: string; payload: PushPayload }[] = [];
  const transport: PushTransport = {
    async send(target, payload) {
      sent.push({ endpoint: target.endpoint, payload });
      const answer = answers[target.endpoint] ?? "delivered";
      if (answer === "throw") throw new Error("network down");
      return answer;
    },
  };
  return { transport, sent };
}

describe("delivering push messages", () => {
  function replyToAna() {
    const ana = addLearner("Ana");
    const phone = addDevice(ana.id, "Chrome on Android");
    const laptop = addDevice(ana.id, "Chrome on Windows");
    const question = postComment(ana.id);
    const { pushMessages } = reply(question.id, addLearner("Sam").id);
    return { ana, phone, laptop, pushMessages };
  }

  it("sends each message to every one of the person's devices", async () => {
    const { phone, laptop, pushMessages } = replyToAna();
    const { transport, sent } = fakeTransport();

    await deliverPushMessages(db, pushMessages, transport);

    expect(sent.map((s) => s.endpoint).sort()).toEqual([laptop, phone].sort());
    expect(sent[0].payload).toEqual({
      title: "Sam replied to your comment on Lesson 3",
      body: "Test Course",
      tag: expect.stringMatching(/^thread:/),
      url: expect.stringContaining("#comment-"),
    });
  });

  it("removes devices the push service reports gone", async () => {
    const { ana, phone, laptop, pushMessages } = replyToAna();
    const { transport } = fakeTransport({ [phone]: "gone" });

    await deliverPushMessages(db, pushMessages, transport);

    expect(listPushDevices(db, ana.id).map((d) => d.endpoint)).toEqual([
      laptop,
    ]);
  });

  it("keeps devices and never throws when sending fails", async () => {
    const { ana, phone, laptop, pushMessages } = replyToAna();
    const { transport } = fakeTransport({ [phone]: "throw", [laptop]: "failed" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      deliverPushMessages(db, pushMessages, transport)
    ).resolves.toBeDefined();

    expect(listPushDevices(db, ana.id)).toHaveLength(2);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("sends a test push only to the device that asked for it", async () => {
    const ana = addLearner("Ana");
    const phone = addDevice(ana.id);
    addDevice(ana.id, "Chrome on Windows");
    const { transport, sent } = fakeTransport();

    await deliverPushMessages(db, [testPushMessage(ana.id, phone)], transport);

    expect(sent).toEqual([
      expect.objectContaining({
        endpoint: phone,
        payload: expect.objectContaining({ title: expect.any(String) }),
      }),
    ]);
  });

  it("doesn't send a test push to someone else's device", async () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const bosPhone = addDevice(bo.id);
    const { transport, sent } = fakeTransport();

    await deliverPushMessages(db, [testPushMessage(ana.id, bosPhone)], transport);

    expect(sent).toEqual([]);
  });
});

describe("push devices", () => {
  it("lists the person's own devices only", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    addDevice(ana.id, "Chrome on Android");
    addDevice(bo.id, "Safari on iPhone");

    expect(listPushDevices(db, ana.id)).toEqual([
      expect.objectContaining({
        deviceName: "Chrome on Android",
        createdAt: NOW.toISOString(),
      }),
    ]);
  });

  it("removes a device by endpoint or id, but only the person's own", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const anasPhone = addDevice(ana.id);
    const anasLaptop = addDevice(ana.id, "Chrome on Windows");
    const bosPhone = addDevice(bo.id);
    const [bosDevice] = listPushDevices(db, bo.id);

    removePushSubscription(db, ana.id, { endpoint: anasPhone });
    removePushSubscription(db, ana.id, { endpoint: bosPhone });
    removePushSubscription(db, ana.id, { id: bosDevice.id });

    expect(listPushDevices(db, ana.id).map((d) => d.endpoint)).toEqual([
      anasLaptop,
    ]);
    expect(listPushDevices(db, bo.id)).toHaveLength(1);
  });

  it("moves a browser's subscription to whoever saves it last", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const shared = addDevice(ana.id);

    savePushSubscription(
      db,
      bo.id,
      { endpoint: shared, p256dh: "new", auth: "new", deviceName: "Chrome on Windows" },
      NOW
    );

    expect(listPushDevices(db, ana.id)).toEqual([]);
    expect(listPushDevices(db, bo.id)).toHaveLength(1);
  });
});

describe("push preferences", () => {
  it("starts every event type switched on", () => {
    const ana = addLearner("Ana");

    expect(getPushPreferences(db, ana.id)).toEqual({
      reply: true,
      question: true,
      announcement: true,
      refund_decision: true,
      refund_request: true,
    });
  });

  it("switches a muted event type back on", () => {
    const ana = addLearner("Ana");
    addDevice(ana.id);
    setPushPreference(db, ana.id, PushEventType.Reply, false);
    setPushPreference(db, ana.id, PushEventType.Reply, true);
    const question = postComment(ana.id);

    const { pushMessages } = reply(question.id, addLearner("Sam").id);

    expect(getPushPreferences(db, ana.id).reply).toBe(true);
    expect(pushMessages).toHaveLength(1);
  });

  it("offers each role only the event types it can receive", () => {
    expect(pushEventTypesFor(UserRole.Student)).toEqual([
      "reply",
      "announcement",
      "refund_decision",
    ]);
    expect(pushEventTypesFor(UserRole.Instructor)).toEqual([
      "reply",
      "question",
    ]);
    expect(pushEventTypesFor(UserRole.Admin)).toEqual([
      "refund_request",
      "reply",
    ]);
  });
});

function ask(userId: number, when = NOW, onLesson = lessonId) {
  const comment = db
    .insert(schema.comments)
    .values({ lessonId: onLesson, userId, parentId: null, body: "How?" })
    .returning()
    .get();
  return recordNotificationEvent(
    db,
    { type: "new_question", commentId: comment.id },
    when
  );
}

describe("a new question on a lesson", () => {
  it("notifies the course's Instructor with a link to the Questions page", () => {
    const ana = addLearner("Ana");

    ask(ana.id);

    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        type: "question",
        title: "Ana asked a question on Lesson 3",
        snippet: "Test Course",
        unread: true,
        url: "/instructor/questions",
      }),
    ]);
  });

  it("never notifies the Instructor about their own comment", () => {
    ask(base.instructor.id);

    expect(listBell(db, base.instructor.id)).toEqual([]);
  });

  it("does nothing for a reply", () => {
    const ana = addLearner("Ana");
    const question = postComment(base.instructor.id);
    const answer = db
      .insert(schema.comments)
      .values({ lessonId, userId: ana.id, parentId: question.id, body: "x" })
      .returning()
      .get();

    recordNotificationEvent(
      db,
      { type: "new_question", commentId: answer.id },
      NOW
    );

    expect(listBell(db, base.instructor.id)).toEqual([]);
  });
});

describe("bundling questions", () => {
  it("merges questions on the same lesson into one unread row", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    ask(ana.id);
    ask(bo.id, minutesAfter(1));
    ask(ana.id, minutesAfter(2));

    const bell = listBell(db, base.instructor.id);
    expect(bell).toEqual([
      expect.objectContaining({
        title: "3 new questions on Lesson 3",
        url: "/instructor/questions",
        lastEventAt: minutesAfter(2).toISOString(),
      }),
    ]);
    expect(getUnreadCount(db, base.instructor.id)).toBe(1);
  });

  it("starts a fresh row once the bundle has been read", () => {
    const ana = addLearner("Ana");
    ask(ana.id);
    ask(ana.id, minutesAfter(1));
    const [row] = listBell(db, base.instructor.id);
    markNotificationRead(db, base.instructor.id, row.id, minutesAfter(2));

    ask(ana.id, minutesAfter(3));

    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        title: "Ana asked a question on Lesson 3",
        unread: true,
      }),
      expect.objectContaining({
        title: "2 new questions on Lesson 3",
        unread: false,
      }),
    ]);
  });

  it("keeps different lessons in separate rows", () => {
    const ana = addLearner("Ana");
    const module = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "More", position: 2 })
      .returning()
      .get();
    const otherLesson = db
      .insert(schema.lessons)
      .values({ moduleId: module.id, title: "Lesson 4", position: 1 })
      .returning()
      .get();
    ask(ana.id);
    ask(ana.id, minutesAfter(1), otherLesson.id);

    expect(listBell(db, base.instructor.id).map((r) => r.title)).toEqual([
      "Ana asked a question on Lesson 4",
      "Ana asked a question on Lesson 3",
    ]);
  });
});
