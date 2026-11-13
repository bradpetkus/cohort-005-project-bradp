import { and, desc, eq, isNull, lt, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  announcements,
  comments,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  notifications,
  notificationSources,
  quizzes,
  users,
  AnnouncementTargetKind,
  NotificationSourceKind,
  NotificationType,
} from "~/db/schema";

// ─── Notifications ───
// The only place that knows notification rules: who hears about an event,
// bundling, and the bell. See GLOSSARY.md (Notification, Announcement) and
// PRD #12.
//
// Every function takes the database first and, where time matters, an
// explicit `now` last, so tests can pass an in-memory database and a fixed
// time. Push is never sent from here: recording an event *returns* the push
// messages to deliver, the way refund functions return an Email.

export type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

// ─── Domain events ───

export type NotificationEvent =
  | { type: "comment_reply"; commentId: number }
  | { type: "announcement_sent"; announcementId: number };

export type PushMessage = {
  userId: number;
  title: string;
  body: string;
  tag: string;
  url: string;
};

export type RecordResult = { pushMessages: PushMessage[] };

export function recordNotificationEvent(
  db: Db,
  event: NotificationEvent,
  now: Date
): RecordResult {
  switch (event.type) {
    case "comment_reply":
      return recordReply(db, event.commentId, now);
    case "announcement_sent":
      return recordAnnouncement(db, event.announcementId, now);
  }
}

function recordReply(db: Db, commentId: number, now: Date): RecordResult {
  const replyRow = db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      lessonId: comments.lessonId,
      actorId: comments.userId,
      actorName: users.name,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(comments.id, commentId))
    .get();
  if (!replyRow || replyRow.parentId === null) return { pushMessages: [] };

  const threadId = replyRow.parentId;
  const thread = db
    .select({ userId: comments.userId })
    .from(comments)
    .where(eq(comments.id, threadId))
    .get();
  if (!thread) return { pushMessages: [] };

  // Earlier repliers: every reply in the thread before this one.
  const earlierRepliers = db
    .select({ userId: comments.userId })
    .from(comments)
    .where(and(eq(comments.parentId, threadId), lt(comments.id, replyRow.id)))
    .all()
    .map((r) => r.userId);

  const recipients = new Set([thread.userId, ...earlierRepliers]);
  recipients.delete(replyRow.actorId);

  db.transaction((tx) => {
    for (const recipientId of recipients) {
      notify(
        tx,
        {
          recipientId,
          type: NotificationType.Reply,
          bundleKey: `thread:${threadId}`,
          actorName: replyRow.actorName,
          courseTitle: replyRow.courseTitle,
          subjectTitle: replyRow.lessonTitle,
          detail:
            recipientId === thread.userId ? REPLY_ON_OWN : REPLY_IN_THREAD,
          note: null,
          destinationUrl: `/courses/${replyRow.courseSlug}/lessons/${replyRow.lessonId}#comment-${threadId}`,
        },
        {
          kind: NotificationSourceKind.Comment,
          id: replyRow.id,
          lessonId: replyRow.lessonId,
        },
        now
      );
    }
  });

  return { pushMessages: [] };
}

// Reply `detail`: is the recipient the thread's top-level author?
const REPLY_ON_OWN = "own_comment";
const REPLY_IN_THREAD = "thread";

// ─── Creating and merging bell rows ───

type BellRowFields = {
  recipientId: number;
  type: NotificationType;
  // Null for types that never bundle.
  bundleKey: string | null;
  actorName: string | null;
  courseTitle: string | null;
  subjectTitle: string | null;
  detail: string | null;
  note: string | null;
  destinationUrl: string;
};

type Source = { kind: NotificationSourceKind; id: number; lessonId: number | null };

// Merges into the recipient's unread row with the same bundle key, moving it
// to the top and its display fields to the latest event, or starts a new row.
function notify(tx: Queryable, fields: BellRowFields, source: Source, now: Date) {
  const iso = now.toISOString();

  const open =
    fields.bundleKey === null
      ? undefined
      : tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.recipientId, fields.recipientId),
              eq(notifications.bundleKey, fields.bundleKey),
              isNull(notifications.readAt)
            )
          )
          .get();

  let notificationId: number;
  if (open) {
    notificationId = open.id;
    tx.update(notifications)
      .set({
        ...fields,
        eventCount: sql`${notifications.eventCount} + 1`,
        lastEventAt: iso,
      })
      .where(eq(notifications.id, open.id))
      .run();
  } else {
    notificationId = tx
      .insert(notifications)
      .values({ ...fields, createdAt: iso, lastEventAt: iso })
      .returning({ id: notifications.id })
      .get().id;
  }

  tx.insert(notificationSources)
    .values({
      notificationId,
      sourceKind: source.kind,
      sourceId: source.id,
      lessonId: source.lessonId,
    })
    .run();
}

// ─── Reading the bell ───

export type BellRow = {
  id: number;
  type: NotificationType;
  title: string;
  snippet: string;
  lastEventAt: string;
  unread: boolean;
  pushed: boolean;
  url: string;
};

type NotificationRow = typeof notifications.$inferSelect;

function titleFor(row: NotificationRow): string {
  switch (row.type) {
    case NotificationType.Reply: {
      const where =
        row.detail === REPLY_ON_OWN
          ? `your comment on ${row.subjectTitle}`
          : `a thread you're in on ${row.subjectTitle}`;
      if (row.eventCount > 1) {
        return `${row.eventCount} new replies ${row.detail === REPLY_ON_OWN ? "on" : "in"} ${where}`;
      }
      return `${row.actorName} replied ${row.detail === REPLY_ON_OWN ? "to" : "in"} ${where}`;
    }
    case NotificationType.Announcement:
      return announcementBellTitle(
        row.actorName ?? "",
        row.detail === AnnouncementTargetKind.Quiz
          ? AnnouncementTargetKind.Quiz
          : AnnouncementTargetKind.Lesson,
        row.subjectTitle ?? ""
      );
    default:
      return "";
  }
}

function snippetFor(row: NotificationRow): string {
  if (row.type === NotificationType.Announcement && row.note) return row.note;
  return row.courseTitle ?? "";
}

// The badge: every unread row, including ones past the dropdown's cap.
export function getUnreadCount(db: Db, userId: number): number {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(notifications)
      .where(
        and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
      )
      .get()?.count ?? 0
  );
}

export const BELL_LIMIT = 30;

// The newest rows by latest event, ready to render. A bundle is one row.
export function listBell(db: Db, userId: number): BellRow[] {
  return db
    .select()
    .from(notifications)
    .where(eq(notifications.recipientId, userId))
    .orderBy(desc(notifications.lastEventAt), desc(notifications.id))
    .limit(BELL_LIMIT)
    .all()
    .map((row) => ({
      id: row.id,
      type: row.type,
      title: titleFor(row),
      snippet: snippetFor(row),
      lastEventAt: row.lastEventAt,
      unread: row.readAt === null,
      pushed: row.pushed,
      url: row.destinationUrl,
    }));
}

// ─── Read state ───
// Both act only on the person's own rows. A bundle is a single row, so
// marking it read covers every event in it.

// Returns the row's destination, or null if it isn't the person's row.
export function markNotificationRead(
  db: Db,
  userId: number,
  notificationId: number,
  now: Date
): string | null {
  const row = db
    .select({
      readAt: notifications.readAt,
      destinationUrl: notifications.destinationUrl,
    })
    .from(notifications)
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.recipientId, userId)
      )
    )
    .get();
  if (!row) return null;

  if (row.readAt === null) {
    db.update(notifications)
      .set({ readAt: now.toISOString() })
      .where(eq(notifications.id, notificationId))
      .run();
  }
  return row.destinationUrl;
}

export function markAllNotificationsRead(
  db: Db,
  userId: number,
  now: Date
): void {
  db.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(eq(notifications.recipientId, userId), isNull(notifications.readAt))
    )
    .run();
}

// ─── Announcements ───
// An Instructor points every Student with a current Enrollment at a lesson or
// quiz. Lapsed Students and the sender never get it, and each Announcement is
// its own bell row (never bundled). A quiz Announcement is stored by its
// lesson, because a quiz gets a new id on every save.

export type AnnouncementTarget = {
  kind: AnnouncementTargetKind;
  lessonId: number;
};

type Failure = { ok: false; status: number; error: string };

export const ANNOUNCEMENT_NOTE_MAX = 280;

// The bell row title, shared by the bell and the review step's preview.
function announcementBellTitle(
  senderName: string,
  kind: AnnouncementTargetKind,
  subjectTitle: string
): string {
  return kind === AnnouncementTargetKind.Quiz
    ? `${senderName} pointed you to the quiz “${subjectTitle}”`
    : `${senderName} pointed you to “${subjectTitle}”`;
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

// Lapsed Students: progress on the course's lessons but no Enrollment
// (GLOSSARY.md). They never get the Announcement.
function lapsedCount(db: Queryable, courseId: number, senderId: number) {
  return (
    db
      .select({ count: sql<number>`count(distinct ${lessonProgress.userId})` })
      .from(lessonProgress)
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

// The lock-screen push for an Announcement. It says only what and where,
// never the note (PRD #12, "Push content and privacy"). The review step
// previews it, and push delivery (#22) sends it.
export function announcementPushText(
  subjectTitle: string,
  courseTitle: string
): { title: string; body: string } {
  return { title: `New Announcement: ${subjectTitle} · ${courseTitle}`, body: "" };
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
  if (!target) {
    return {
      ok: false,
      status: 404,
      error: "That lesson or quiz isn't on this course.",
    };
  }
  const sender = db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, input.senderId))
    .get();
  const note = input.note?.trim() || null;

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
  const note = input.note?.trim() || null;
  if (note !== null && note.length > ANNOUNCEMENT_NOTE_MAX) {
    return {
      ok: false,
      status: 400,
      error: `The note can be at most ${ANNOUNCEMENT_NOTE_MAX} characters.`,
    };
  }
  if (!resolveTarget(db, input.courseId, input.target)) {
    return {
      ok: false,
      status: 404,
      error: "That lesson or quiz isn't on this course.",
    };
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

  const { pushMessages } = recordNotificationEvent(
    db,
    { type: "announcement_sent", announcementId },
    now
  );
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

function recordAnnouncement(
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
  if (!row) return { pushMessages: [] };

  const target = resolveTarget(db, row.courseId, {
    kind: row.targetKind,
    lessonId: row.lessonId,
  });
  if (!target) return { pushMessages: [] };

  const recipients = currentStudents(db, row.courseId, row.senderId);

  db.transaction((tx) => {
    for (const recipient of recipients) {
      notify(
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
    }
  });

  // Push for Announcements lands with #22, worded by announcementPushText.
  return { pushMessages: [] };
}
