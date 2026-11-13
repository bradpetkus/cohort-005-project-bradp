import { and, eq, inArray, type SQL } from "drizzle-orm";
import {
  announcements,
  lessons,
  notificationSources,
  AnnouncementTargetKind,
  NotificationSourceKind,
} from "~/db/schema";
import {
  noPush,
  removeSources,
  type Db,
  type RecordResult,
  type Tx,
} from "./core.server";

// ─── Deleted sources (#19) ───
// The bell never points at something that's gone. Each row loses one event
// per deleted source, and disappears at zero. Edits are never events.
//
// Lessons, quizzes and modules are hard-deleted: go through
// deleteWithNotifications, which cleans up first (so a module's lessons can
// still be found) and deletes in the same transaction. Comments are
// soft-deleted: record "comment_deleted" after.

export type SourceDeletedEvent =
  | { type: "comment_deleted"; commentId: number }
  | { type: "lesson_deleted"; lessonId: number }
  | { type: "quiz_deleted"; lessonId: number }
  | { type: "module_deleted"; moduleId: number };

export type HardDeleteEvent = Exclude<
  SourceDeletedEvent,
  { type: "comment_deleted" }
>;

// Hard-deletes a lesson, quiz or module and cleans up the bell in one
// transaction: if the delete throws, nothing is removed.
export function deleteWithNotifications<T>(
  db: Db,
  event: HardDeleteEvent,
  hardDelete: (tx: Tx) => T
): T {
  return db.transaction((tx) => {
    removeDeletedSource(tx, event);
    return hardDelete(tx);
  });
}

export function recordSourceDeleted(
  db: Db,
  event: SourceDeletedEvent
): RecordResult {
  db.transaction((tx) => removeDeletedSource(tx, event));
  return noPush();
}

function removeDeletedSource(tx: Tx, event: SourceDeletedEvent) {
  switch (event.type) {
    case "comment_deleted":
      removeSources(
        tx,
        and(
          eq(notificationSources.sourceKind, NotificationSourceKind.Comment),
          eq(notificationSources.sourceId, event.commentId)
        )
      );
      break;
    case "lesson_deleted":
      removeLessons(tx, [event.lessonId]);
      break;
    case "module_deleted":
      removeLessons(
        tx,
        tx
          .select({ id: lessons.id })
          .from(lessons)
          .where(eq(lessons.moduleId, event.moduleId))
          .all()
          .map((l) => l.id)
      );
      break;
    case "quiz_deleted":
      removeAnnouncements(
        tx,
        and(
          eq(announcements.lessonId, event.lessonId),
          eq(announcements.targetKind, AnnouncementTargetKind.Quiz)
        )
      );
      break;
  }
}

// Everything under the lessons: comment rows and Announcements (lesson and
// quiz) with their rows. Sources carry their lessonId, so this works even
// after the comments are gone.
function removeLessons(tx: Tx, lessonIds: number[]) {
  if (lessonIds.length === 0) return;
  removeSources(tx, inArray(notificationSources.lessonId, lessonIds));
  removeAnnouncements(tx, inArray(announcements.lessonId, lessonIds));
}

function removeAnnouncements(tx: Tx, where: SQL | undefined) {
  const ids = tx
    .delete(announcements)
    .where(where)
    .returning({ id: announcements.id })
    .all()
    .map((a) => a.id);
  if (ids.length === 0) return;
  removeSources(
    tx,
    and(
      eq(notificationSources.sourceKind, NotificationSourceKind.Announcement),
      inArray(notificationSources.sourceId, ids)
    )
  );
}
