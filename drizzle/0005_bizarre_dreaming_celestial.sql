ALTER TABLE `daily_picks` MODIFY COLUMN `city` enum('austin','san_antonio','dallas') NOT NULL;--> statement-breakpoint
ALTER TABLE `reposts` MODIFY COLUMN `city` enum('austin','san_antonio','dallas') NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` MODIFY COLUMN `city` enum('austin','san_antonio','dallas') NOT NULL;