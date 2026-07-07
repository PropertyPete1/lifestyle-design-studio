import { getDb } from './server/db.js';
import { igReels } from './drizzle/schema.js';
import { eq } from 'drizzle-orm';

const db = await getDb();
const reel = await db.select({
  id: igReels.id,
  igMediaId: igReels.igMediaId,
  city: igReels.city,
  reelLink: igReels.reelLink,
  postedAt: igReels.postedAt,
}).from(igReels).where(eq(igReels.id, 30094));

console.log("Austin reel 30094:", JSON.stringify(reel[0]));
process.exit(0);
