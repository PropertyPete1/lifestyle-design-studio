CREATE TABLE `linkedin_posts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`postDate` varchar(10) NOT NULL,
	`topic` varchar(64) NOT NULL,
	`body` text NOT NULL,
	`status` enum('draft','scheduled','posted','failed') NOT NULL DEFAULT 'draft',
	`metricoolPostId` varchar(64),
	`errorReason` text,
	`scheduledFor` bigint,
	`postedAt` bigint,
	`impressions` int NOT NULL DEFAULT 0,
	`reactions` int NOT NULL DEFAULT 0,
	`comments` int NOT NULL DEFAULT 0,
	`shares` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `linkedin_posts_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_linkedin_post_date` UNIQUE(`postDate`)
);
