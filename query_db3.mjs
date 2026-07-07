import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';

const db = await getDb();

// Check ig_reels table
const [count] = await db.execute(sql`SELECT COUNT(*) as cnt FROM ig_reels`);
console.log("ig_reels count:", count);

// Find the specific reels
const reels = await db.execute(sql`SELECT id, shortcode, permalink, city, thumbnailUrl FROM ig_reels WHERE id IN (30025, 30079)`);
console.log("Reels 30025/30079:", JSON.stringify(reels, null, 2));

// If not found, check what IDs exist
if (reels.length === 0) {
  const sample = await db.execute(sql`SELECT id, shortcode, city FROM ig_reels ORDER BY id DESC LIMIT 5`);
  console.log("Last 5 ig_reels:", JSON.stringify(sample));
}

process.exit(0);
