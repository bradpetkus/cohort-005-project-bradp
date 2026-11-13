import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  announcements,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  quizzes,
  users,
  AnnouncementTargetKind,
  NotificationSourceKind,
  NotificationType,
  UserRole,
} from "~/db/schema";
import {
  addToBell,
  deleteExpiredNotifications,
  noPush,
  type Db,
  type PushMessage,
  type Queryable,
  type RecordResult,
} from "./core.server";
import { announcementBellTitle, announcementPushText } from "./display.server";

// ─── Announcements ───
// An Instructor points every Student with a current Enrollment at a lesson or
// quiz. Lapsed Students and the sender never get it, and each Announcement is
// its own bell row (never bundled). A quiz Announcement is stored by its
// lesson, because a quiz gets a new id on every save.

export type AnnouncementEvent = {
  type: "announcement_sent";
  announcementId: number;
};

export type AnnouncementTarget = {
  kind: AnnouncementTargetKind;
  lessonId: number;
};

type Failure = { ok: false; status: number; error: string };

const TARGET_NOT_ON_COURSE: Failure = {
  ok: false,
  status: 404,
  error: "That lesson or quiz isn't on this course.",
};

export const ANNOUNCEMENT_NOTE_MAX = 280;

// A blank note is no note.
function cleanNote(note: string | null): string | null {
  return note?.trim() || null;
}

type ResolvedTarget = {
  subjectTitle: string;
  courseTitle: string;
  courseSlug: string;
};

// What the lesson or quiz is called now, or null if it isn't on the course.
function resolveTarget(
  db: Queryable,
  courseId: number,
  target: AnnouncementTarget
): ResolvedTarget | null {
  const lesson = db
    .select({
      title: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(and(eq(lessons.id, target.lessonId), eq(courses.id, courseId)))
    .get();
  if (!lesson) return null;

  let subjectTitle = lesson.title;
  if (target.kind === AnnouncementTargetKind.Quiz) {
    const quiz = db
      .select({ title: quizzes.title })
      .from(quizzes)
      .where(eq(quizzes.lessonId, target.lessonId))
      .get();
    if (!quiz) return null;
    subjectTitle = quiz.title;
  }
  return {
    subjectTitle,
    courseTitle: lesson.courseTitle,
    courseSlug: lesson.courseSlug,
  };
}

// Students with a current Enrollment on the course, minus the sender.
function currentStudents(db: Queryable, courseId: number, senderId: number) {
  return db
    .select({ id: users.id, name: users.name })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(
      and(eq(enrollments.courseId, courseId), ne(enrollments.userId, senderId))
    )
    .orderBy(users.name)
    .all();
}

// Lapsed Students: Students with progress on the course's lessons but no
// Enrollment (GLOSSARY.md). Staff with progress aren't Students. Lapsed
// Students never get the Announcement.
function lapsedCount(db: Queryable, courseId: number, senderId: number) {
  return (
    db
      .select({ count: sql<number>`count(distinct ${lessonProgress.userId})` })
      .from(lessonProgress)
      .innerJoin(
        users,
        and(
          eq(users.id, lessonProgress.userId),
          eq(users.role, UserRole.Student)
        )
      )
      .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .leftJoin(
        enrollments,
        and(
          eq(enrollments.userId, lessonProgress.userId),
          eq(enrollments.courseId, courseId)
        )
      )
      .where(
        and(
          eq(modules.courseId, courseId),
          isNull(enrollments.id),
          ne(lessonProgress.userId, senderId)
        )
      )
      .get()?.count ?? 0
  );
}

export type AnnouncementPreview = {
  ok: true;
  recipients: { id: number; name: string }[];
  lapsedCount: number;
  // The latest earlier Announcement of the same lesson or quiz, if any.
  lastAnnounced: { sentAt: string; reachedCount: number } | null;
  bellRow: { title: string; snippet: string };
  push: { title: string; body: string };
};

// The review step: who it reaches, who is left out, and what they'll see.
export function previewAnnouncement(
  db: Db,
  input: SendAnnouncementInput
): AnnouncementPreview | Failure {
  const target = resolveTarget(db, input.courseId, input.target);
  if (!target) return TARGET_NOT_ON_COURSE;
  const sender = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.senderId))
    .get();
  const note = cleanNote(input.note);

  const last = db
    .select({
      sentAt: announcements.sentAt,
      reachedCount: announcements.reachedCount,
    })
    .from(announcements)
    .where(
      and(
        eq(announcements.courseId, input.courseId),
        eq(announcements.lessonId, input.target.lessonId),
        eq(announcements.targetKind, input.target.kind)
      )
    )
    .orderBy(desc(announcements.sentAt), desc(announcements.id))
    .get();

  return {
    ok: true,
    recipients: currentStudents(db, input.courseId, input.senderId),
    lapsedCount: lapsedCount(db, input.courseId, input.senderId),
    lastAnnounced: last ?? null,
    bellRow: {
      title: announcementBellTitle(
        sender?.name ?? "",
        input.target.kind,
        target.subjectTitle
      ),
      snippet: note ?? target.courseTitle,
    },
    push: announcementPushText(target.subjectTitle, target.courseTitle),
  };
}

export type SendAnnouncementInput = {
  courseId: number;
  senderId: number;
  target: AnnouncementTarget;
  note: string | null;
};

export type SendAnnouncementResult =
  | {
      ok: true;
      announcementId: number;
      reachedCount: number;
      pushMessages: PushMessage[];
    }
  | Failure;

// Stores the Announcement and records the event. Access (the course's own
// Instructor, or a Platform Admin) is checked by the route.
export function sendAnnouncement(
  db: Db,
  input: SendAnnouncementInput,
  now: Date
): SendAnnouncementResult {
  const note = cleanNote(input.note);
  if (note !== null && note.length > ANNOUNCEMENT_NOTE_MAX) {
    return {
      ok: false,
      status: 400,
      error: `The note can be at most ${ANNOUNCEMENT_NOTE_MAX} characters.`,
    };
  }
  if (!resolveTarget(db, input.courseId, input.target)) {
    return TARGET_NOT_ON_COURSE;
  }

  const reachedCount = currentStudents(
    db,
    input.courseId,
    input.senderId
  ).length;
  const announcementId = db
    .insert(announcements)
    .values({
      courseId: input.courseId,
      senderId: input.senderId,
      targetKind: input.target.kind,
      lessonId: input.target.lessonId,
      note,
      sentAt: now.toISOString(),
      reachedCount,
    })
    .returning({ id: announcements.id })
    .get().id;

  // As recordNotificationEvent does for "announcement_sent".
  deleteExpiredNotifications(db, now);
  const { pushMessages } = recordAnnouncement(db, announcementId, now);
  return { ok: true, announcementId, reachedCount, pushMessages };
}

export type SentAnnouncement = {
  id: number;
  targetKind: AnnouncementTargetKind;
  lessonId: number;
  // The lesson's or quiz's current title.
  subjectTitle: string;
  note: string | null;
  sentAt: string;
  reachedCount: number;
};

// Every Announcement on the course, newest first.
export function listAnnouncements(
  db: Db,
  courseId: number
): SentAnnouncement[] {
  return db
    .select({
      id: announcements.id,
      targetKind: announcements.targetKind,
      lessonId: announcements.lessonId,
      lessonTitle: lessons.title,
      quizTitle: quizzes.title,
      note: announcements.note,
      sentAt: announcements.sentAt,
      reachedCount: announcements.reachedCount,
    })
    .from(announcements)
    .innerJoin(lessons, eq(lessons.id, announcements.lessonId))
    .leftJoin(quizzes, eq(quizzes.lessonId, announcements.lessonId))
    .where(eq(announcements.courseId, courseId))
    .orderBy(desc(announcements.sentAt), desc(announcements.id))
    .all()
    .map(({ lessonTitle, quizTitle, ...row }) => ({
      ...row,
      subjectTitle:
        row.targetKind === AnnouncementTargetKind.Quiz
          ? (quizTitle ?? `Quiz on ${lessonTitle}`)
          : lessonTitle,
    }));
}

export function recordAnnouncement(
  db: Db,
  announcementId: number,
  now: Date
): RecordResult {
  const row = db
    .select({
      courseId: announcements.courseId,
      senderId: announcements.senderId,
      targetKind: announcements.targetKind,
      lessonId: announcements.lessonId,
      note: announcements.note,
      senderName: users.name,
    })
    .from(announcements)
    .innerJoin(users, eq(users.id, announcements.senderId))
    .where(eq(announcements.id, announcementId))
    .get();
  if (!row) return noPush();

  const target = resolveTarget(db, row.courseId, {
    kind: row.targetKind,
    lessonId: row.lessonId,
  });
  if (!target) return noPush();

  const recipients = currentStudents(db, row.courseId, row.senderId);

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    for (const recipient of recipients) {
      const push = addToBell(
        tx,
        {
          recipientId: recipient.id,
          type: NotificationType.Announcement,
          bundleKey: null,
          actorName: row.senderName,
          courseTitle: target.courseTitle,
          subjectTitle: target.subjectTitle,
          detail: row.targetKind,
          note: row.note,
          destinationUrl: `/courses/${target.courseSlug}/lessons/${row.lessonId}`,
        },
        {
          kind: NotificationSourceKind.Announcement,
          id: announcementId,
          lessonId: row.lessonId,
        },
        now
      );
      if (push) pushMessages.push(push);
    }
  });

  return { pushMessages };
}
