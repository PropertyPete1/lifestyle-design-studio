/**
 * Seed ig_post_history with recent Instagram posts.
 * Run: node scripts/seed-ig-history.mjs <path-to-mcp-result.json>
 */
import { readFileSync } from "fs";
import { createConnection } from "mysql2/promise";
import { config } from "dotenv";

config(); // load .env

const resultFile = process.argv[2];
if (!resultFile) throw new Error("Please provide path to MCP result JSON file");

const raw = JSON.parse(readFileSync(resultFile, "utf8"));
const posts = raw?.result?.data ?? [];
console.log(`Total posts from API: ${posts.length}`);

const now = Date.now();
const cutoffMs = now - 30 * 24 * 60 * 60 * 1000;

const recentVideos = posts
  .filter(p => p.media_type === "VIDEO")
  .map(p => ({
    igPostId: p.id,
    thumbnailUrl: p.thumbnail_url || p.media_url || "",
    captionSnippet: (p.caption || "").slice(0, 500),
    postedAt: new Date(p.timestamp).getTime(),
  }))
  .filter(p => p.postedAt >= cutoffMs);

console.log(`Recent video posts to seed: ${recentVideos.length}`);

const db = await createConnection(process.env.DATABASE_URL);

let inserted = 0, skipped = 0;
for (const p of recentVideos) {
  try {
    await db.execute(
      `INSERT INTO ig_post_history (igPostId, thumbnailUrl, captionSnippet, postedAt)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         thumbnailUrl = VALUES(thumbnailUrl),
         captionSnippet = VALUES(captionSnippet),
         postedAt = VALUES(postedAt)`,
      [p.igPostId, p.thumbnailUrl, p.captionSnippet, p.postedAt]
    );
    inserted++;
    console.log(`  Seeded: ${p.igPostId} (${new Date(p.postedAt).toISOString().slice(0, 10)})`);
  } catch (err) {
    skipped++;
    console.error(`  FAILED ${p.igPostId}: ${err.message}`);
  }
}

await db.end();
console.log(`\nDone: ${inserted} seeded, ${skipped} failed`);
