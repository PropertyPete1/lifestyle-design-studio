import { getDb } from "./server/db.ts";
const db = await getDb();
const [cols] = await db.execute("SHOW COLUMNS FROM reposts");
console.log("Columns:", cols.map(c => c.Field).join(", "));
const [reposts] = await db.execute("SELECT * FROM reposts WHERE daily_pick_id = 390002 ORDER BY id DESC");
console.log("=== Reposts for pick 390002 ===");
reposts.forEach(r => console.log(JSON.stringify(r)));
process.exit(0);
