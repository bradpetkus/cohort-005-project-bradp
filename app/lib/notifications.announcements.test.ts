import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import {
  AnnouncementTargetKind,
  LessonProgressStatus,
  NotificationType,
  UserRole,
} from "~/db/schema";
import {
  getUnreadCount,
  listAnnouncements,
  listBell,
  previewAnnouncement,
  sendAnnouncement,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function daysAfter(days: number) {
  return new Date(NOW.getTime() + days * 24 * 60 * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;
let otherLessonId: number;

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

  otherLessonId = db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title: "Lesson 5", position: 2 })
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

function enroll(userId: number) {
  db.insert(schema.enrollments)
    .values({ userId, courseId: base.course.id })
    .run();
}

// A Lapsed Student: progress on the course, no Enrollment.
function addLapsed(name: string) {
  const learner = addLearner(name);
  db.insert(schema.lessonProgress)
    .values({
      userId: learner.id,
      lessonId,
      status: LessonProgressStatus.Completed,
    })
    .run();
  return learner;
}

function addQuiz(title: string) {
  return db
    .insert(schema.quizzes)
    .values({ lessonId, title, passingScore: 0.7 })
    .returning()
    .get();
}

function eqId(quizId: number) {
  return eq(schema.quizzes.id, quizId);
}

function send(
  target: { kind: AnnouncementTargetKind; lessonId: number } = {
    kind: AnnouncementTargetKind.Lesson,
    lessonId,
  },
  note: string | null = null,
  when = NOW
) {
  const result = sendAnnouncement(
    db,
    {
      courseId: base.course.id,
      senderId: base.instructor.id,
      target,
      note,
    },
    when
  );
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("sending an Announcement", () => {
  it("gives every Student with a current Enrollment a bell row", () => {
    const sam = addLearner("Sam");
    const ana = addLearner("Ana");
    enroll(sam.id);
    enroll(ana.id);

    const result = send(undefined, "Start here before Friday.");

    expect(result.reachedCount).toBe(2);
    for (const student of [sam, ana]) {
      expect(listBell(db, student.id)).toEqual([
        expect.objectContaining({
          type: NotificationType.Announcement,
          title: "Test Instructor pointed you to “Lesson 4”",
          snippet: "Start here before Friday.",
          unread: true,
          url: `/courses/test-course/lessons/${lessonId}`,
        }),
      ]);
    }
  });
});

function preview(
  target: { kind: AnnouncementTargetKind; lessonId: number } = {
    kind: AnnouncementTargetKind.Lesson,
    lessonId,
  },
  note: string | null = "Start here before Friday."
) {
  const result = previewAnnouncement(db, {
    courseId: base.course.id,
    senderId: base.instructor.id,
    target,
    note,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("previewing an Announcement", () => {
  it("counts Students with a current Enrollment and Lapsed Students, and names the recipients", () => {
    enroll(addLearner("Sam").id);
    enroll(addLearner("Ana").id);
    addLapsed("Lee");
    addLapsed("Kim");
    addLapsed("Max");
    addLearner("Never Started");
    enroll(base.instructor.id);

    const result = preview();

    expect(result.recipients.map((r) => r.name)).toEqual(["Ana", "Sam"]);
    expect(result.lapsedCount).toBe(3);
  });

  it("previews the bell row with the note, and push text without it", () => {
    addQuiz("Check your understanding");

    expect(preview()).toMatchObject({
      bellRow: {
        title: "Test Instructor pointed you to “Lesson 4”",
        snippet: "Start here before Friday.",
      },
      push: { title: "New Announcement: Lesson 4 · Test Course" },
    });
    const quiz = preview({ kind: AnnouncementTargetKind.Quiz, lessonId });
    expect(quiz.push.title).toBe(
      "New Announcement: Check your understanding · Test Course"
    );
    expect(JSON.stringify(quiz.push)).not.toContain("Friday");
  });

  it("warns when the lesson or quiz was announced before, with the latest date and reach", () => {
    enroll(addLearner("Sam").id);
    addQuiz("Check your understanding");
    expect(preview().lastAnnounced).toBeNull();

    send(undefined, null, NOW);
    enroll(addLearner("Ana").id);
    send(undefined, null, daysAfter(2));

    expect(preview().lastAnnounced).toEqual({
      sentAt: daysAfter(2).toISOString(),
      reachedCount: 2,
    });
    expect(
      preview({ kind: AnnouncementTargetKind.Quiz, lessonId }).lastAnnounced
    ).toBeNull();
    expect(
      preview({ kind: AnnouncementTargetKind.Lesson, lessonId: otherLessonId })
        .lastAnnounced
    ).toBeNull();
  });
});

describe("the sent history", () => {
  it("lists every Announcement on the course, newest first", () => {
    enroll(addLearner("Sam").id);
    addQuiz("Check your understanding");

    send(undefined, "First look", NOW);
    enroll(addLearner("Ana").id);
    send(
      { kind: AnnouncementTargetKind.Quiz, lessonId },
      null,
      daysAfter(1)
    );

    expect(listAnnouncements(db, base.course.id)).toEqual([
      expect.objectContaining({
        targetKind: AnnouncementTargetKind.Quiz,
        subjectTitle: "Check your understanding",
        note: null,
        sentAt: daysAfter(1).toISOString(),
        reachedCount: 2,
      }),
      expect.objectContaining({
        targetKind: AnnouncementTargetKind.Lesson,
        subjectTitle: "Lesson 4",
        note: "First look",
        sentAt: NOW.toISOString(),
        reachedCount: 1,
      }),
    ]);
  });

  it("only lists the course's own Announcements", () => {
    send();
    const otherCourse = db
      .insert(schema.courses)
      .values({
        title: "Other",
        slug: "other",
        description: "",
        salesCopy: "",
        instructorId: base.instructor.id,
        categoryId: base.category.id,
        status: schema.CourseStatus.Published,
      })
      .returning()
      .get();

    expect(listAnnouncements(db, otherCourse.id)).toEqual([]);
  });
});

describe("the note", () => {
  it("accepts 280 characters and rejects 281", () => {
    const sam = addLearner("Sam");
    enroll(sam.id);
    const target = { kind: AnnouncementTargetKind.Lesson, lessonId };
    const input = (note: string) => ({
      courseId: base.course.id,
      senderId: base.instructor.id,
      target,
      note,
    });

    expect(sendAnnouncement(db, input("a".repeat(280)), NOW)).toMatchObject({
      ok: true,
    });
    expect(sendAnnouncement(db, input("a".repeat(281)), NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(getUnreadCount(db, sam.id)).toBe(1);
  });
});

describe("a quiz Announcement", () => {
  it("names the quiz and links to its lesson, even after the quiz is re-created", () => {
    const sam = addLearner("Sam");
    enroll(sam.id);
    const quiz = addQuiz("Check your understanding");

    send({ kind: AnnouncementTargetKind.Quiz, lessonId });
    // Saving a quiz deletes and re-creates it with a new id.
    db.delete(schema.quizzes).where(eqId(quiz.id)).run();
    addQuiz("Check your understanding v2");

    expect(listBell(db, sam.id)).toEqual([
      expect.objectContaining({
        title:
          "Test Instructor pointed you to the quiz “Check your understanding”",
        snippet: "Test Course",
        url: `/courses/test-course/lessons/${lessonId}`,
      }),
    ]);
  });

  it("can't be sent for a lesson with no quiz", () => {
    expect(
      sendAnnouncement(
        db,
        {
          courseId: base.course.id,
          senderId: base.instructor.id,
          target: { kind: AnnouncementTargetKind.Quiz, lessonId },
          note: null,
        },
        NOW
      )
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("who an Announcement reaches", () => {
  it("never reaches Lapsed Students or the sender", () => {
    const sam = addLearner("Sam");
    enroll(sam.id);
    const lapsed = addLapsed("Lee");
    enroll(base.instructor.id);

    const result = send();

    expect(result.reachedCount).toBe(1);
    expect(getUnreadCount(db, sam.id)).toBe(1);
    expect(getUnreadCount(db, lapsed.id)).toBe(0);
    expect(getUnreadCount(db, base.instructor.id)).toBe(0);
  });

  it("gives each Announcement its own row, never bundled", () => {
    const sam = addLearner("Sam");
    enroll(sam.id);

    send(undefined, null, NOW);
    send(
      { kind: AnnouncementTargetKind.Lesson, lessonId: otherLessonId },
      null,
      daysAfter(1)
    );
    send(undefined, null, daysAfter(2));

    expect(getUnreadCount(db, sam.id)).toBe(3);
    expect(listBell(db, sam.id).map((row) => row.title)).toEqual([
      "Test Instructor pointed you to “Lesson 4”",
      "Test Instructor pointed you to “Lesson 5”",
      "Test Instructor pointed you to “Lesson 4”",
    ]);
  });
});
