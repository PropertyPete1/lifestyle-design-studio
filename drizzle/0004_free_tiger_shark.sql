CREATE TABLE `ig_post_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`igPostId` varchar(32) NOT NULL,
	`thumbnailUrl` varchar(512),
	`captionSnippet` varchar(500),
	`visualDescription` text,
	`postedAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ig_post_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `ig_post_history_igPostId_unique` UNIQUE(`igPostId`)
);
