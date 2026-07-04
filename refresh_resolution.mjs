import { execSync } from 'child_process';
import { getDb } from './server/db.ts';
import { driveVideos } from './drizzle/schema.ts';
import { eq } from 'drizzle-orm';

const FOLDER_ID = '16mNnK1avek0LUljjFPZ5iNxON2OJZod7';

async function main() {
  const db = await getDb();
  
  let allFiles = [];
  let pageToken = null;
  let page = 0;
  
  do {
    page++;
    const params = {
      q: `'${FOLDER_ID}' in parents and mimeType contains 'video'`,
      fields: "files(id,name,size,videoMediaMetadata),nextPageToken",
      pageSize: 500,
    };
    if (pageToken) params.pageToken = pageToken;
    
    const paramsJson = JSON.stringify(params);
    // Must use double-quote shell escaping (single quotes break inner single quotes in the query)
    const escaped = paramsJson.replace(/"/g, '\\"');
    const cmd = `gws drive files list --params "${escaped}"`;
    console.log(`Page ${page}...`);
    
    const result = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    const data = JSON.parse(result);
    const files = data.files || [];
    allFiles.push(...files);
    pageToken = data.nextPageToken || null;
    console.log(`  Got ${files.length} files (total: ${allFiles.length})`);
  } while (pageToken);
  
  console.log(`\nTotal files from Drive: ${allFiles.length}`);
  
  // Update each file's width/height/sizeBytes in the DB
  let updated = 0;
  let withRes = 0;
  
  for (const f of allFiles) {
    const meta = f.videoMediaMetadata || {};
    const width = meta.width || null;
    const height = meta.height || null;
    const sizeBytes = f.size ? parseInt(f.size) : null;
    const durationMs = meta.durationMillis ? parseInt(meta.durationMillis) : null;
    
    if (width) withRes++;
    
    // Upsert: update if exists, insert if not
    try {
      await db.insert(driveVideos).values({
        driveFileId: f.id,
        fileName: f.name,
        mimeType: 'video/mp4',
        sizeBytes,
        durationMs,
        width,
        height,
        lastIndexedAt: Date.now(),
      }).onDuplicateKeyUpdate({
        set: {
          sizeBytes,
          durationMs,
          width,
          height,
          lastIndexedAt: Date.now(),
        }
      });
      updated++;
    } catch (e) {
      console.error(`  Error updating ${f.name}: ${e.message}`);
    }
  }
  
  console.log(`\nUpdated ${updated} records`);
  console.log(`Files with resolution metadata: ${withRes}`);
  
  // Summary
  const rows = await db.select().from(driveVideos);
  const resolutions = {};
  for (const r of rows) {
    const key = r.width && r.height ? `${r.width}x${r.height}` : 'no_meta';
    resolutions[key] = (resolutions[key] || 0) + 1;
  }
  console.log('\nDB Resolution distribution:');
  for (const [k, v] of Object.entries(resolutions).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
