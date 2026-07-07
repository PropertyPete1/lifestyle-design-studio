import { getDb } from "./server/db.ts";
const db = await getDb();
// Reset Austin pick to confirmed so we can re-post it with voiceover
await db.execute("UPDATE daily_picks SET status = 'confirmed' WHERE id = 390002");
console.log("Reset pick 390002 to confirmed");
// Verify
const [pick] = await db.execute("SELECT id, city, status, videoId, driveVideoUrl FROM daily_picks WHERE id = 390002");
console.log("Pick:", JSON.stringify(pick, null, 2));
process.exit(0);
