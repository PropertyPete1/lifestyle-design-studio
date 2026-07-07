import { setDriveToken, verifyDriveAccess } from './server/driveAuth.js';
import { preprocessDriveOriginals } from './server/drivePreprocess.js';
import * as db from './server/db.js';

const token = process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
if (!token) {
  console.error("No GOOGLE_WORKSPACE_CLI_TOKEN available");
  process.exit(1);
}

console.log(`[1/4] Setting Drive token (${token.length} chars)...`);
await setDriveToken(token);

console.log("[2/4] Verifying Drive access...");
const health = await verifyDriveAccess();
console.log("Drive health:", JSON.stringify(health));

if (!health.healthy) {
  console.error("Drive is not healthy! Cannot proceed.");
  process.exit(1);
}

console.log("[3/4] Running Drive preprocessing for today's picks...");
const result = await preprocessDriveOriginals();
console.log("Preprocess result:", JSON.stringify(result, null, 2));

// Check if picks now have driveVideoUrl
const picks = await db.getDailyPicks('2026-07-07');
for (const p of picks) {
  console.log(`Pick ${p.id} (${p.city}): driveVideoUrl = ${p.driveVideoUrl ? p.driveVideoUrl.slice(0,50) + '...' : 'NULL'}`);
}

process.exit(0);
