import { getDb } from './server/db.js';
import { igReels } from './drizzle/schema.js';
import { eq, inArray } from 'drizzle-orm';

const db = await getDb();

// The daily_picks.postId = ig_reels.igMediaId
// The daily_picks.videoId = ig_reels.id
const reels = await db.select({
  id: igReels.id,
  igMediaId: igReels.igMediaId,
  city: igReels.city,
  reelLink: igReels.reelLink,
  postedAt: igReels.postedAt,
}).from(igReels).where(inArray(igReels.id, [30025, 30079]));

console.log("Reel 30025:", JSON.stringify(reels.find(r => r.id === 30025)));
console.log("Reel 30079:", JSON.stringify(reels.find(r => r.id === 30079)));

process.exit(0);
