import { getConfirmedDuePicks, getDailyPicks } from './server/db.js';

const now = Date.now();
console.log("Current time:", new Date(now).toLocaleString('en-US', {timeZone:'America/Chicago'}));

console.log("\n=== DUE PICKS (confirmed + scheduledFor <= now) ===");
const due = await getConfirmedDuePicks(now);
if (due.length === 0) {
  console.log("No picks are due right now.");
} else {
  for (const p of due) {
    console.log(`ID:${p.id} | City:${p.city} | Status:${p.status} | VideoId:${p.videoId} | PostId:${p.postId}`);
  }
}

// Also check today's picks full details
const today = new Date().toISOString().split('T')[0];
console.log(`\n=== ALL PICKS FOR ${today} ===`);
const picks = await getDailyPicks(today);
for (const p of picks) {
  console.log(JSON.stringify({id:p.id, city:p.city, status:p.status, videoId:p.videoId, postId:p.postId, repostId:p.repostId, scheduledFor:p.scheduledFor, driveVideoUrl:p.driveVideoUrl}));
}

process.exit(0);
