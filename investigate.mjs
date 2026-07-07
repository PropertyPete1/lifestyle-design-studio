import { getDb } from "./server/db.ts";
const db = await getDb();

// Get the Austin pick details
const [picks] = await db.execute("SELECT id, city, videoId, postId, driveVideoUrl, status FROM daily_picks WHERE id = 390002");
console.log("=== Austin Pick 390002 ===");
console.log(JSON.stringify(picks[0], null, 2));

// Get the reel info - first check columns
const [cols] = await db.execute("SHOW COLUMNS FROM ig_reels");
console.log("\n=== ig_reels columns ===");
console.log(cols.map(c => c.Field).join(", "));

// Get the reel
const videoId = picks[0].videoId;
const [reels] = await db.execute(`SELECT * FROM ig_reels WHERE id = ${videoId}`);
console.log("\n=== Reel for videoId", videoId, "===");
const reel = reels[0];
console.log("igMediaId:", reel?.igMediaId);
console.log("caption (first 100):", reel?.caption?.substring(0, 100));
console.log("thumbnailStorageKey:", reel?.thumbnailStorageKey);
console.log("permalink:", reel?.permalink);

// Check the voiceover job
const [jobs] = await db.execute("SELECT id, pickId, status, renderedVideoStorageKey FROM voiceover_jobs WHERE pickId = 390002 ORDER BY id DESC LIMIT 1");
console.log("\n=== Voiceover Job ===");
console.log(JSON.stringify(jobs[0], null, 2));

// Check the driveVideoUrl storage key - is it the Hutto house or the North Austin house?
console.log("\n=== Drive Video URL (storage key) ===");
console.log(picks[0].driveVideoUrl);

process.exit(0);
