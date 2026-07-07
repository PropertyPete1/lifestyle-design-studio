import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';

const db = await getDb();

// Get columns
const cols = await db.execute(sql`SHOW COLUMNS FROM ig_reels`);
console.log("Columns:", cols.map(c => c.Field).join(', '));

// Get the two reels we need - just key fields
const reels = await db.execute(sql`SELECT id, postId, city, permalink, postedAt FROM ig_reels WHERE id IN (30025, 30079)`);
console.log("\nReel 30025:", JSON.stringify(reels.find(r => r.id === 30025)));
console.log("Reel 30079:", JSON.stringify(reels.find(r => r.id === 30079)));

process.exit(0);
