CREATE TABLE `analyst_insights` (
	`id` int AUTO_INCREMENT NOT NULL,
	`runDate` varchar(10) NOT NULL,
	`summary` text NOT NULL,
	`data` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analyst_insights_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_analyst_run_date` UNIQUE(`runDate`)
);
--> statement-breakpoint
CREATE TABLE `post_metrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`network` varchar(24) NOT NULL,
	`blogId` bigint NOT NULL,
	`brandLabel` varchar(128),
	`networkPostId` varchar(64) NOT NULL,
	`captionSnippet` varchar(500),
	`publishedAt` bigint,
	`views` int NOT NULL DEFAULT 0,
	`reach` int NOT NULL DEFAULT 0,
	`likes` int NOT NULL DEFAULT 0,
	`comments` int NOT NULL DEFAULT 0,
	`shares` int NOT NULL DEFAULT 0,
	`saved` int NOT NULL DEFAULT 0,
	`skipRate` int,
	`avgWatchTimeSec` int,
	`isAutoPost` int NOT NULL DEFAULT 0,
	`capturedOn` varchar(10) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `post_metrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_metrics_net_post_day` UNIQUE(`network`,`networkPostId`,`capturedOn`)
);
