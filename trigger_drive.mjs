import { driveHealthCheck } from './server/driveIndex.js';
import { preprocessDriveOriginals } from './server/drivePreprocess.js';

console.log("Checking Drive health...");
const health = await driveHealthCheck();
console.log("Drive health:", JSON.stringify(health));

if (health.healthy) {
  console.log("\nDrive is healthy! Running preprocessing...");
  const result = await preprocessDriveOriginals();
  console.log("Preprocess result:", JSON.stringify(result, null, 2));
} else {
  console.log("Drive is NOT healthy:", health.error);
}

process.exit(0);
