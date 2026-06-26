CREATE TABLE `daily_picks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pickDate` varchar(10) NOT NULL,
	`city` enum('austin','san_antonio') NOT NULL,
	`videoId` int NOT NULL,
	`postId` varchar(32) NOT NULL,
	`refreshedCaption` text,
	`selectionMode` varchar(16) NOT NULL DEFAULT 'fresh',
	`scheduledFor` bigint,
	`status` enum('pending','confirmed','posted','failed') NOT NULL DEFAULT 'pending',
	`repostId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `daily_picks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reposts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`videoId` int NOT NULL,
	`postId` varchar(32) NOT NULL,
	`city` enum('austin','san_antonio') NOT NULL,
	`captionUsed` text,
	`viewsAtRepost` int NOT NULL DEFAULT 0,
	`thumbnailUrl` varchar(512),
	`scheduledFor` bigint,
	`status` enum('confirmed','posted','failed') NOT NULL DEFAULT 'confirmed',
	`confirmedAt` timestamp NOT NULL DEFAULT (now()),
	`postedAt` timestamp,
	CONSTRAINT `reposts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`postId` varchar(32) NOT NULL,
	`shortcode` varchar(32),
	`permalink` varchar(255),
	`city` enum('austin','san_antonio') NOT NULL,
	`caption` text,
	`views` int NOT NULL DEFAULT 0,
	`likeCount` int NOT NULL DEFAULT 0,
	`commentsCount` int NOT NULL DEFAULT 0,
	`thumbnailUrl` varchar(512),
	`onscreenText` varchar(255),
	`originalTimestamp` varchar(40),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `videos_id` PRIMARY KEY(`id`),
	CONSTRAINT `videos_postId_unique` UNIQUE(`postId`)
);
