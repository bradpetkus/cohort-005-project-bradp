import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getUnreadCount,
  listBell,
  markAllNotificationsRead,
  markNotificationRead,
  recordNotificationEvent,
} from "./notifications.server";

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

  it("returns no push messages yet", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);

    expect(reply(question.id, sam.id).pushMessages).toEqual([]);
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
