import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { AnnouncementTargetKind, UserRole } from "~/db/schema";
import {
  listAnnouncements,
  listBell,
  markAllNotificationsRead,
  recordNotificationEvent,
  sendAnnouncement,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesAfter(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

function daysAfter(days: number) {
  return minutesAfter(days * 24 * 60);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let moduleId: number;
let lessonId: number;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  moduleId = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get().id;

  lessonId = addLesson("Lesson 3");
});

function addLesson(title: string, inModule = moduleId) {
  return db
    .insert(schema.lessons)
    .values({ moduleId: inModule, title, position: 1 })
    .returning()
    .get().id;
}

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

function postComment(
  userId: number,
  parentId: number | null = null,
  onLesson = lessonId
) {
  return db
    .insert(schema.comments)
    .values({ lessonId: onLesson, userId, parentId, body: "Hello" })
    .returning()
    .get();
}

function reply(parentId: number, userId: number, when = NOW) {
  const comment = postComment(userId, parentId);
  recordNotificationEvent(
    db,
    { type: "comment_reply", commentId: comment.id },
    when
  );
  return comment;
}

function ask(userId: number, onLesson = lessonId, when = NOW) {
  const comment = postComment(userId, null, onLesson);
  recordNotificationEvent(
    db,
    { type: "new_question", commentId: comment.id },
    when
  );
  return comment;
}

// What the lesson page's delete-comment action does: soft-delete, then tell
// the notifications module.
function deleteComment(commentId: number, when = NOW) {
  db.update(schema.comments)
    .set({ deletedAt: when.toISOString() })
    .where(eqComment(commentId))
    .run();
  recordNotificationEvent(db, { type: "comment_deleted", commentId }, when);
}

function eqComment(id: number) {
  return eq(schema.comments.id, id);
}

function enroll(userId: number) {
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

function addQuiz(onLesson = lessonId) {
  return db
    .insert(schema.quizzes)
    .values({ lessonId: onLesson, title: "Check", passingScore: 0.7 })
    .returning()
    .get();
}

function announce(
  kind: AnnouncementTargetKind = AnnouncementTargetKind.Lesson,
  onLesson = lessonId
) {
  const result = sendAnnouncement(
    db,
    {
      courseId: base.course.id,
      senderId: base.instructor.id,
      target: { kind, lessonId: onLesson },
      note: null,
    },
    NOW
  );
  if (!result.ok) throw new Error(result.error);
}

function sentHistory() {
  return listAnnouncements(db, base.course.id).map((a) => ({
    lessonId: a.lessonId,
    kind: a.targetKind,
  }));
}

describe("deleting a comment", () => {
  it("removes the reply's row from the bell", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    const answer = reply(question.id, sam.id);

    deleteComment(answer.id);

    expect(listBell(db, ana.id)).toEqual([]);
  });

  it("lowers a bundle's count by one", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    reply(question.id, bo.id);
    const second = reply(question.id, sam.id, minutesAfter(1));
    reply(question.id, bo.id, minutesAfter(2));

    deleteComment(second.id);

    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({
        title: "2 new replies on your comment on Lesson 3",
      }),
    ]);
  });

  it("keeps the row's original wording when a bundle drops to one", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    reply(question.id, bo.id);
    const latest = reply(question.id, sam.id, minutesAfter(1));

    deleteComment(latest.id);

    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({
        title: "Sam replied to your comment on Lesson 3",
      }),
    ]);
  });

  it("removes a bundle once every reply in it is deleted", () => {
    const ana = addLearner("Ana");
    const bo = addLearner("Bo");
    const question = postComment(ana.id);
    const first = reply(question.id, bo.id);
    const second = reply(question.id, bo.id, minutesAfter(1));

    deleteComment(first.id);
    deleteComment(second.id);

    expect(listBell(db, ana.id)).toEqual([]);
  });

  it("removes a question from the Instructor's bundle", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const first = ask(ana.id);
    ask(sam.id, lessonId, minutesAfter(1));

    deleteComment(first.id);

    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        title: "Sam asked a question on Lesson 3",
      }),
    ]);
  });

  it("keeps the rows for replies under a deleted top-level comment", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = ask(ana.id);
    reply(question.id, sam.id);

    deleteComment(question.id);

    expect(listBell(db, base.instructor.id)).toEqual([]);
    expect(listBell(db, ana.id)).toEqual([
      expect.objectContaining({
        title: "Sam replied to your comment on Lesson 3",
      }),
    ]);
  });
});

// What the Instructor course page's delete-lesson action does: tell the
// notifications module first, then hard-delete.
function deleteLesson(id: number) {
  recordNotificationEvent(db, { type: "lesson_deleted", lessonId: id }, NOW);
  db.delete(schema.lessons).where(eq(schema.lessons.id, id)).run();
}

describe("deleting a lesson", () => {
  it("removes its Announcements, for the lesson and its quiz, and their rows", () => {
    const sam = addLearner("Sam");
    enroll(sam.id);
    addQuiz();
    announce(AnnouncementTargetKind.Lesson);
    announce(AnnouncementTargetKind.Quiz);
    const otherLesson = addLesson("Lesson 4");
    announce(AnnouncementTargetKind.Lesson, otherLesson);

    db.delete(schema.quizzes).run();
    deleteLesson(lessonId);

    expect(sentHistory()).toEqual([
      { lessonId: otherLesson, kind: AnnouncementTargetKind.Lesson },
    ]);
    expect(listBell(db, sam.id)).toEqual([
      expect.objectContaining({
        url: `/courses/test-course/lessons/${otherLesson}`,
      }),
    ]);
  });

  it("removes the rows for questions asked on it", () => {
    const ana = addLearner("Ana");
    ask(ana.id);
    const otherLesson = addLesson("Lesson 4");
    ask(ana.id, otherLesson, minutesAfter(1));

    recordNotificationEvent(db, { type: "lesson_deleted", lessonId }, NOW);

    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({
        title: "Ana asked a question on Lesson 4",
      }),
    ]);
  });
});

describe("deleting a quiz", () => {
  it("removes the quiz's Announcements and their rows, but not the lesson's", () => {
    const sam = addLearner("Sam");
    enroll(sam.id);
    addQuiz();
    announce(AnnouncementTargetKind.Lesson);
    announce(AnnouncementTargetKind.Quiz);

    recordNotificationEvent(db, { type: "quiz_deleted", lessonId }, NOW);
    db.delete(schema.quizzes).run();

    expect(sentHistory()).toEqual([
      { lessonId, kind: AnnouncementTargetKind.Lesson },
    ]);
    expect(listBell(db, sam.id)).toEqual([
      expect.objectContaining({
        title: "Test Instructor pointed you to “Lesson 3”",
      }),
    ]);
  });
});

describe("deleting a module", () => {
  it("removes everything under each of its lessons", () => {
    const ana = addLearner("Ana");
    enroll(ana.id);
    const second = addLesson("Lesson 4");
    announce(AnnouncementTargetKind.Lesson, second);
    ask(ana.id);
    ask(ana.id, second, minutesAfter(1));
    const otherModule = db
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "More", position: 2 })
      .returning()
      .get().id;
    const kept = addLesson("Lesson 9", otherModule);
    ask(ana.id, kept, minutesAfter(2));

    recordNotificationEvent(db, { type: "module_deleted", moduleId }, NOW);

    expect(sentHistory()).toEqual([]);
    expect(listBell(db, ana.id)).toEqual([]);
    expect(listBell(db, base.instructor.id)).toEqual([
      expect.objectContaining({ title: "Ana asked a question on Lesson 9" }),
    ]);
  });
});

describe("editing a source", () => {
  it("leaves bell rows as they were", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    enroll(ana.id);
    const question = postComment(ana.id);
    const answer = reply(question.id, sam.id);
    announce(AnnouncementTargetKind.Lesson);
    const before = listBell(db, ana.id);

    db.update(schema.comments)
      .set({ body: "Edited" })
      .where(eqComment(answer.id))
      .run();
    db.update(schema.lessons)
      .set({ title: "Renamed" })
      .where(eq(schema.lessons.id, lessonId))
      .run();

    expect(listBell(db, ana.id)).toEqual(before);
  });
});

describe("retention", () => {
  it("deletes rows older than 90 days, read or unread, when the next event is recorded", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const old = postComment(ana.id);
    reply(old.id, sam.id, NOW);
    const read = postComment(ana.id);
    reply(read.id, sam.id, NOW);
    markAllNotificationsRead(db, ana.id, NOW);
    const recent = postComment(ana.id);
    reply(recent.id, sam.id, daysAfter(1));

    const fresh = postComment(ana.id);
    reply(fresh.id, sam.id, daysAfter(91));

    expect(listBell(db, ana.id).map((r) => r.url)).toEqual([
      `/courses/test-course/lessons/${lessonId}#comment-${fresh.id}`,
      `/courses/test-course/lessons/${lessonId}#comment-${recent.id}`,
    ]);
  });

  it("keeps a row exactly 90 days old", () => {
    const ana = addLearner("Ana");
    const sam = addLearner("Sam");
    const question = postComment(ana.id);
    reply(question.id, sam.id, NOW);

    const other = postComment(ana.id);
    reply(other.id, sam.id, daysAfter(90));

    expect(listBell(db, ana.id)).toHaveLength(2);
  });
});
