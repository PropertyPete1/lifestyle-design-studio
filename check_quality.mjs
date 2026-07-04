import { db } from './server/db.ts';
import { dailyPicks, driveVideos } from './drizzle/schema.ts';
import { eq } from 'drizzle-orm';

async function main() {
  const picks = await db.select().from(dailyPicks).where(eq(dailyPicks.pickDate, '2026-07-04'));
  for (const p of picks) {
    console.log(`\n=== ${p.city} (${p.status}) ===`);
    console.log(`driveVideoUrl: ${p.driveVideoUrl}`);
    
    if (p.driveVideoUrl) {
      const allDrive = await db.select().from(driveVideos);
      const matched = allDrive.find(d => p.driveVideoUrl?.includes(d.driveId));
      if (matched) {
        console.log(`Drive file: ${matched.filename}`);
        console.log(`Size: ${(Number(matched.sizeBytes) / 1024 / 1024).toFixed(1)} MB`);
      } else {
        console.log('No matching drive_videos record found');
      }
    }
  }
  process.exit(0);
}
main();
