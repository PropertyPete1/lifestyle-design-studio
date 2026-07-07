import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';
const db = await getDb();

// Check voiceover jobs
const jobs = await db.execute(sql`SELECT * FROM voiceover_jobs ORDER BY id DESC LIMIT 5`);
console.log("Recent voiceover jobs:", JSON.stringify(jobs[0], null, 2));

// Check voiceover budget
const budget = await db.execute(sql`SELECT * FROM voiceover_budget ORDER BY id DESC LIMIT 3`);
console.log("\nVoiceover budget:", JSON.stringify(budget[0], null, 2));

// Check if autoVoiceover exists in settings
const vo = await db.execute(sql`SELECT * FROM app_settings WHERE settingKey = 'autoVoiceover'`);
console.log("\nautoVoiceover setting:", JSON.stringify(vo[0]));

process.exit(0);
