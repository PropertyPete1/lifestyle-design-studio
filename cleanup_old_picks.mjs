import { getDb } from './server/db.js';
import { sql } from 'drizzle-orm';

const db = await getDb();

// Reset any stuck picks from previous dates that are still "confirmed" (not today)
const result = await db.execute(sql`
  SELECT id, pickDate, city, status, driveMatchConfidence 
  FROM daily_picks 
  WHERE status = 'confirmed' AND pickDate != '2026-07-07'
  ORDER BY pickDate DESC
  LIMIT 20
`);
console.log("Stuck picks from other dates:", JSON.stringify(result[0], null, 2));

process.exit(0);
