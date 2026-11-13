import { and, eq, lt } from "drizzle-orm";
import {
  comments,
  courses,
  lessons,
  modules,
  users,
  NotificationSourceKind,
  NotificationType,
} from "~/db/schema";
import {
  addToBell,
  noPush,
  type Db,
  type PushMessage,
  type RecordResult,
} from "./core.server";

// ─── Comments: questions and replies ───

export type CommentEvent =
  | { type: "comment_reply"; commentId: number }
  | { type: "new_question"; commentId: number };

// A new top-level comment notifies the course's Instructor, never the asker.
// Questions bundle by lesson and all lead to the Questions queue.
export function recordQuestion(
  db: Db,
  commentId: number,
  now: Date
): RecordResult {
  const question = db
    .select({
      id: comments.id,
      parentId: comments.parentId,
      lessonId: comments.lessonId,
      actorId: comments.userId,
      actorName: users.name,
      lessonTitle: lessons.title,
      courseTitle: courses.title,
      instructorId: courses.instructorId,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(courses, eq(courses.id, modules.courseId))
    .where(eq(comments.id, commentId))
    .get();
  if (!question || question.parentId !== null) return noPush();
  if (question.instructorId === question.actorId) return noPush();

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    const push = addToBell(
      tx,
      {
        recipientId: question.instructorId,
        type: NotificationType.Question,
        bundleKey: `lesson:${question.lessonId}`,
        actorName: question.actorName,
        courseTitle: question.courseTitle,
        subjectTitle: question.lessonTitle,
        detail: null,
        note: null,
        destinationUrl: "/instructor/questions",
      },
      {
        kind: NotificationSourceKind.Comment,
        id: question.id,
        lessonId: question.lessonId,
      },
      now
    );
    if (push) pushMessages.push(push);
  });

  return { pushMessages };
}

export function recordReply(
  db: Db,
  commentId: number,
  now: Date
): RecordResult {
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
  if (!replyRow || replyRow.parentId === null) return noPush();

  const threadId = replyRow.parentId;
  const thread = db
    .select({ userId: comments.userId })
    .from(comments)
    .where(eq(comments.id, threadId))
    .get();
  if (!thread) return noPush();

  // Earlier repliers: every reply in the thread before this one.
  const earlierRepliers = db
    .select({ userId: comments.userId })
    .from(comments)
    .where(and(eq(comments.parentId, threadId), lt(comments.id, replyRow.id)))
    .all()
    .map((r) => r.userId);

  const recipients = new Set([thread.userId, ...earlierRepliers]);
  recipients.delete(replyRow.actorId);

  const pushMessages: PushMessage[] = [];
  db.transaction((tx) => {
    for (const recipientId of recipients) {
      const push = addToBell(
        tx,
        {
          recipientId,
          type: NotificationType.Reply,
          bundleKey: `thread:${threadId}`,
          actorName: replyRow.actorName,
          courseTitle: replyRow.courseTitle,
          subjectTitle: replyRow.lessonTitle,
          detail: recipientId === thread.userId ? "own_comment" : "thread",
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
      if (push) pushMessages.push(push);
    }
  });

  return { pushMessages };
}
