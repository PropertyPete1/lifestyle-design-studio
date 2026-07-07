import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';

const db = await getDb();

// Check ig_reels columns
const cols = await db.execute(sql`SHOW COLUMNS FROM ig_reels`);
console.log("ig_reels columns:", cols.map(c => c.Field).join(', '));

// Find the specific reels by id
const reels = await db.execute(sql`SELECT * FROM ig_reels WHERE id IN (30025, 30079) LIMIT 2`);
console.log("\nReels 30025/30079:", JSON.stringify(reels.slice(0,2), null, 2));

process.exit(0);
