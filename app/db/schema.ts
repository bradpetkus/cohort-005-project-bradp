import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export enum UserRole {
  Student = "student",
  Instructor = "instructor",
  Admin = "admin",
}

export enum CourseStatus {
  Draft = "draft",
  Published = "published",
  Archived = "archived",
}

export enum LessonProgressStatus {
  NotStarted = "not_started",
  InProgress = "in_progress",
  Completed = "completed",
}

export enum QuestionType {
  MultipleChoice = "multiple_choice",
  TrueFalse = "true_false",
}

export enum RefundStatus {
  Open = "open",
  Approved = "approved",
  Declined = "declined",
}

export enum TeamMemberRole {
  Admin = "admin",
  Member = "member",
}

// ─── Tables ───

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: text("role").notNull().$type<UserRole>(),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
});

export const courses = sqliteTable("courses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description").notNull(),
  notes: text("notes"),
  // Markdown, non-empty. Enforced on write.
  salesCopy: text("sales_copy").notNull(),
  instructorId: integer("instructor_id")
    .notNull()
    .references(() => users.id),
  categoryId: integer("category_id")
    .notNull()
    .references(() => categories.id),
  status: text("status").notNull().$type<CourseStatus>(),
  coverImageUrl: text("cover_image_url"),
  price: integer("price").notNull().default(0),
  pppEnabled: integer("ppp_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const modules = sqliteTable("modules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  courseId: integer("course_id")
    .notNull()
    .references(() => courses.id),
  title: text("title").notNull(),
  position: integer("position").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const lessons = sqliteTable("lessons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  moduleId: integer("module_id")
    .notNull()
    .references(() => modules.id),
  title: text("title").notNull(),
  content: text("content"),
  videoUrl: text("video_url"),
  githubRepoUrl: text("github_repo_url"),
  position: integer("position").notNull(),
  durationMinutes: integer("duration_minutes"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const enrollments = sqliteTable(
  "enrollments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    enrolledAt: text("enrolled_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    completedAt: text("completed_at"),
  },
  (table) => [index("enrollments_course_idx").on(table.courseId)]
);

export const lessonProgress = sqliteTable(
  "lesson_progress",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessons.id),
    status: text("status").notNull().$type<LessonProgressStatus>(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("lesson_progress_user_lesson_idx").on(table.userId, table.lessonId),
  ]
);

export const quizzes = sqliteTable("quizzes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessons.id),
  title: text("title").notNull(),
  passingScore: real("passing_score").notNull(),
});

export const quizQuestions = sqliteTable("quiz_questions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzes.id),
  questionText: text("question_text").notNull(),
  questionType: text("question_type").notNull().$type<QuestionType>(),
  position: integer("position").notNull(),
});

export const quizOptions = sqliteTable("quiz_options", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  questionId: integer("question_id")
    .notNull()
    .references(() => quizQuestions.id),
  optionText: text("option_text").notNull(),
  isCorrect: integer("is_correct", { mode: "boolean" }).notNull(),
});

export const quizAttempts = sqliteTable("quiz_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  quizId: integer("quiz_id")
    .notNull()
    .references(() => quizzes.id),
  score: real("score").notNull(),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  attemptedAt: text("attempted_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const quizAnswers = sqliteTable("quiz_answers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  attemptId: integer("attempt_id")
    .notNull()
    .references(() => quizAttempts.id),
  questionId: integer("question_id")
    .notNull()
    .references(() => quizQuestions.id),
  selectedOptionId: integer("selected_option_id")
    .notNull()
    .references(() => quizOptions.id),
});

export const purchases = sqliteTable(
  "purchases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    amountPaid: integer("amount_paid").notNull(),
    country: text("country"),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index("purchases_course_idx").on(table.courseId)]
);

export const refunds = sqliteTable(
  "refunds",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    purchaseId: integer("purchase_id")
      .notNull()
      .references(() => purchases.id),
    status: text("status")
      .notNull()
      .$type<RefundStatus>()
      .default(RefundStatus.Open),
    // The student's own words, in the box on the course page.
    reason: text("reason").notNull(),
    // Null until someone approves — a declined request refunds nothing.
    amountRefunded: integer("amount_refunded"),
    requestedAt: text("requested_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    resolvedAt: text("resolved_at"),
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    // The Platform Admin's note to the buyer. Required on a decline, optional
    // on an approval. Enforced on write.
    decisionNote: text("decision_note"),
  },
  (table) => [index("refunds_purchase_idx").on(table.purchaseId)]
);

export const teams = sqliteTable("teams", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const teamMembers = sqliteTable("team_members", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  role: text("role").notNull().$type<TeamMemberRole>(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const coupons = sqliteTable("coupons", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  teamId: integer("team_id")
    .notNull()
    .references(() => teams.id),
  courseId: integer("course_id")
    .notNull()
    .references(() => courses.id),
  code: text("code").notNull().unique(),
  purchaseId: integer("purchase_id")
    .notNull()
    .references(() => purchases.id),
  redeemedByUserId: integer("redeemed_by_user_id").references(() => users.id),
  redeemedAt: text("redeemed_at"),
  // Set on every Unclaimed Seat when its Team Licence's Refund Request is
  // approved. The Seat can never be claimed after that.
  refundedAt: text("refunded_at"),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

export const courseRatings = sqliteTable(
  "course_ratings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    // Whole stars, 1–5. Enforced on write.
    rating: integer("rating").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    uniqueIndex("course_ratings_user_course_unique").on(
      table.userId,
      table.courseId
    ),
  ]
);

export const comments = sqliteTable(
  "comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessons.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    // Null for a top-level comment. Replies are one level deep only — a parent
    // must itself be top-level. Enforced on write.
    parentId: integer("parent_id").references(
      (): AnySQLiteColumn => comments.id
    ),
    // Markdown, 1–5000 chars. Enforced on write, rendered by
    // renderComment (untrusted input — never renderMarkdown).
    body: text("body").notNull(),
    createdAt: text("created_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    // Null until the author edits. An explicit column rather than comparing
    // updatedAt to createdAt, which collide when both writes land in the same
    // millisecond.
    editedAt: text("edited_at"),
    // Soft delete. Deleted top-level comments keep their replies readable.
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("comments_lesson_idx").on(table.lessonId),
    index("comments_parent_idx").on(table.parentId),
  ]
);

export const videoWatchEvents = sqliteTable("video_watch_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  lessonId: integer("lesson_id")
    .notNull()
    .references(() => lessons.id),
  eventType: text("event_type").notNull(),
  positionSeconds: real("position_seconds").notNull(),
  createdAt: text("created_at")
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

// ─── Notifications ───
// One migration holds every table for the Notifications PRD (#12). See
// GLOSSARY.md for Notification and Announcement.
//
// Nothing here has an FK into comments or quizzes, and notification rows have
// none into lessons. Lessons, quizzes and modules are hard-deleted, and
// quizzes get a new id on every save, so an FK would block those writes.
// Sources are a polymorphic (kind, id) pair instead, cleaned up by the
// notifications module.

export enum NotificationType {
  Reply = "reply",
  Question = "question",
  Announcement = "announcement",
  RefundDecision = "refund_decision",
  RefundRequest = "refund_request",
  Purchase = "purchase",
  EnrollmentGained = "enrollment_gained",
  EnrollmentEnded = "enrollment_ended",
  SeatClaimed = "seat_claimed",
}

// What a notification_sources row points at. No FK; see above.
export enum NotificationSourceKind {
  Comment = "comment",
  Announcement = "announcement",
  RefundRequest = "refund_request",
  Purchase = "purchase",
  Enrollment = "enrollment",
  Seat = "seat",
}

// The push event types a person can mute.
export enum PushEventType {
  Reply = "reply",
  Question = "question",
  Announcement = "announcement",
  RefundDecision = "refund_decision",
  RefundRequest = "refund_request",
}

// What an Announcement points at. A lesson has at most one quiz, and a quiz
// gets a new id on every save, so a quiz Announcement is keyed by its lesson.
export enum AnnouncementTargetKind {
  Lesson = "lesson",
  Quiz = "quiz",
}

// One row per bell row. A bundled row stands for eventCount events.
export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    recipientId: integer("recipient_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull().$type<NotificationType>(),
    // Null for types that never bundle. A new event merges only into the
    // recipient's unread row with the same key.
    bundleKey: text("bundle_key"),
    eventCount: integer("event_count").notNull().default(1),
    // Display fields captured when the row is created (and moved to the latest
    // event on a merge), so the wording never changes when a source is
    // edited. Comment text is never stored.
    actorName: text("actor_name"),
    courseTitle: text("course_title"),
    // The lesson or quiz title.
    subjectTitle: text("subject_title"),
    // A type-specific variant, e.g. whether a reply is on the recipient's own
    // comment, or a refund decision's outcome.
    detail: text("detail"),
    // Announcement note or decision note. Shown in the bell, never pushed.
    note: text("note"),
    // An internal path, never an absolute URL.
    destinationUrl: text("destination_url").notNull(),
    pushed: integer("pushed", { mode: "boolean" }).notNull().default(false),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
    // Rows sort by this.
    lastEventAt: text("last_event_at").notNull(),
  },
  (table) => [
    index("notifications_recipient_read_idx").on(
      table.recipientId,
      table.readAt
    ),
    index("notifications_created_idx").on(table.createdAt),
    index("notifications_recipient_bundle_idx").on(
      table.recipientId,
      table.bundleKey
    ),
  ]
);

// One row per underlying event in a bell row.
export const notificationSources = sqliteTable(
  "notification_sources",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    notificationId: integer("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull().$type<NotificationSourceKind>(),
    sourceId: integer("source_id").notNull(),
    // The lesson this source sits under (comments, Announcements), so deleting
    // a lesson, quiz or module still finds its rows once the comments or quiz
    // are gone. No FK.
    lessonId: integer("lesson_id"),
  },
  (table) => [
    index("notification_sources_notification_idx").on(table.notificationId),
    index("notification_sources_source_idx").on(
      table.sourceKind,
      table.sourceId
    ),
    index("notification_sources_lesson_idx").on(table.lessonId),
  ]
);

export const announcements = sqliteTable(
  "announcements",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    courseId: integer("course_id")
      .notNull()
      .references(() => courses.id),
    senderId: integer("sender_id")
      .notNull()
      .references(() => users.id),
    targetKind: text("target_kind").notNull().$type<AnnouncementTargetKind>(),
    // The lesson, or the lesson whose quiz is announced. Hard-deleting the
    // lesson deletes its Announcements (but not their Notifications: the
    // notifications module removes those first).
    lessonId: integer("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    // At most 280 chars. Enforced on write.
    note: text("note"),
    sentAt: text("sent_at").notNull(),
    reachedCount: integer("reached_count").notNull(),
  },
  (table) => [
    index("announcements_course_idx").on(table.courseId),
    index("announcements_lesson_idx").on(table.lessonId),
  ]
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    // A capability URL. Treat it as a secret.
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    deviceName: text("device_name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("push_subscriptions_user_idx").on(table.userId)]
);

// Only muted (user, event type) pairs are stored, so every push event type is
// on by default, including ones added later.
export const pushPreferences = sqliteTable(
  "push_preferences",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    eventType: text("event_type").notNull().$type<PushEventType>(),
  },
  (table) => [
    uniqueIndex("push_preferences_user_event_unique").on(
      table.userId,
      table.eventType
    ),
  ]
);
