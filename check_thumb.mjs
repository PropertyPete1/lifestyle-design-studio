import { getDb } from "./server/db.ts";
const db = await getDb();
const [cols] = await db.execute("SHOW COLUMNS FROM ig_reels");
console.log("ig_reels columns:", cols.map(c => c.Field).join(", "));
// Get the reel for postId 17940731214170679
const [reels] = await db.execute("SELECT * FROM ig_reels WHERE igMediaId = '17940731214170679'");
console.log("\n=== Reel for postId 17940731214170679 ===");
if (reels[0]) console.log(JSON.stringify(reels[0], null, 2));
else console.log("NOT FOUND");
// Get reel id=37
const [reels2] = await db.execute("SELECT * FROM ig_reels WHERE id = 37");
console.log("\n=== Reel id=37 ===");
if (reels2[0]) console.log(JSON.stringify(reels2[0], null, 2));
else console.log("NOT FOUND");
process.exit(0);
