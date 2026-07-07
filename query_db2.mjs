import { getDb } from './server/db.js';
import { videos } from './drizzle/schema.js';
import { sql } from 'drizzle-orm';

const db = await getDb();
const [count] = await db.select({ count: sql`COUNT(*)` }).from(videos);
console.log("Total videos in DB:", count);

// Check if there's a different table name
const [tables] = await db.execute(sql`SHOW TABLES`);
console.log("Tables:", JSON.stringify(tables));

process.exit(0);
