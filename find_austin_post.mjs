import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';
const db = await getDb();

// Get SA pick to compare
const sa = await db.execute(sql`
  SELECT id, city, videoId, postId, repostId, status, driveVideoUrl
  FROM daily_picks
  WHERE pickDate = '2026-07-07' AND city = 'san_antonio'
`);
console.log("SA pick:", JSON.stringify(sa[0], null, 2));

// Get the SA reel
const saReel = await db.execute(sql`
  SELECT id, igMediaId, city, reelLink
  FROM ig_reels WHERE id = ${sa[0][0].videoId}
`);
console.log("\nSA reel:", JSON.stringify(saReel[0], null, 2));

process.exit(0);
