import { getDb } from "./server/db.ts";
const db = await getDb();
const [jobs] = await db.execute("SELECT script FROM voiceover_jobs WHERE pickId = 390002 ORDER BY id DESC LIMIT 1");
console.log("=== Austin Voiceover Script ===");
console.log(jobs[0]?.script);
process.exit(0);
