CREATE TABLE `announcements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`sender_id` integer NOT NULL,
	`target_kind` text NOT NULL,
	`lesson_id` integer NOT NULL,
	`note` text,
	`sent_at` text NOT NULL,
	`reached_count` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `announcements_course_idx` ON `announcements` (`course_id`);--> statement-breakpoint
CREATE INDEX `announcements_lesson_idx` ON `announcements` (`lesson_id`);--> statement-breakpoint
CREATE TABLE `notification_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` integer NOT NULL,
	`lesson_id` integer,
	FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_sources_notification_idx` ON `notification_sources` (`notification_id`);--> statement-breakpoint
CREATE INDEX `notification_sources_source_idx` ON `notification_sources` (`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `notification_sources_lesson_idx` ON `notification_sources` (`lesson_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_id` integer NOT NULL,
	`type` text NOT NULL,
	`bundle_key` text,
	`event_count` integer DEFAULT 1 NOT NULL,
	`actor_name` text,
	`course_title` text,
	`subject_title` text,
	`detail` text,
	`note` text,
	`destination_url` text NOT NULL,
	`pushed` integer DEFAULT false NOT NULL,
	`read_at` text,
	`created_at` text NOT NULL,
	`last_event_at` text NOT NULL,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_read_idx` ON `notifications` (`recipient_id`,`read_at`);--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_bundle_idx` ON `notifications` (`recipient_id`,`bundle_key`);--> statement-breakpoint
CREATE TABLE `push_preferences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`event_type` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_preferences_user_event_unique` ON `push_preferences` (`user_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device_name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);