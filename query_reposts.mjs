import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';

const db = await getDb();
const rows = await db.execute(sql`SELECT id, city, status, metricoolPostId, postedAt FROM repost_history WHERE id IN (300001, 300002) ORDER BY id`);
console.log(JSON.stringify(rows[0], null, 2));
process.exit(0);
