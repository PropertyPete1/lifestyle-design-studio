import { getDb } from './server/db.js';
import { videos, dailyPicks } from './drizzle/schema.js';
import { eq, inArray, sql } from 'drizzle-orm';

const db = await getDb();

// Check what video IDs exist
const allVids = await db.select({ id: videos.id, postId: videos.postId, shortcode: videos.shortcode, city: videos.city }).from(videos).orderBy(sql`id DESC`).limit(10);
console.log("Last 10 videos:", JSON.stringify(allVids, null, 2));

// Check today's picks
const picks = await db.select().from(dailyPicks).where(eq(dailyPicks.pickDate, '2026-07-07'));
console.log("\nToday's picks:", JSON.stringify(picks, null, 2));

process.exit(0);
