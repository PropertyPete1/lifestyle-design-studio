// Extract thumbnail_url from all scraped IG pages and update ig_reels via scrapeReels endpoint
import { SignJWT } from 'jose';
import { readFileSync, readdirSync } from 'fs';

const secret = new TextEncoder().encode(process.env.JWT_SECRET);
const openId = process.env.OWNER_OPEN_ID;
const appId = process.env.VITE_APP_ID;

const token = await new SignJWT({ openId, appId, name: 'Peter Allen' })
  .setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h')
  .sign(secret);

// Read all MCP result files from the scraping session
const mcpDir = '/tmp/manus-mcp';
const files = readdirSync(mcpDir).filter(f => f.startsWith('mcp_result_'));

const allReels = [];

for (const file of files) {
  try {
    const data = JSON.parse(readFileSync(`${mcpDir}/${file}`, 'utf-8'));
    // Check if this is a post_list result (has result.data array with posts)
    if (data?.result?.data && Array.isArray(data.result.data)) {
      for (const post of data.result.data) {
        if (post.media_type === 'VIDEO' && post.thumbnail_url && post.id) {
          allReels.push({
            igMediaId: post.id,
            caption: post.caption || '',
            likes: post.like_count || 0,
            comments: post.comments_count || 0,
            shares: 0,
            saved: 0,
            views: 0, // Will be overridden by existing data
            reelLink: post.permalink || '',
            postedAt: new Date(post.timestamp).getTime(),
            thumbnailUrl: post.thumbnail_url, // THIS IS THE KEY FIELD
          });
        }
      }
    }
  } catch (e) {
    // Skip non-post-list results (insights, etc.)
  }
}

console.log(`Found ${allReels.length} reels with thumbnail URLs`);

if (allReels.length === 0) {
  console.log('No reels found with thumbnails');
  process.exit(1);
}

// Show first few
for (const r of allReels.slice(0, 3)) {
  console.log(`  ${r.igMediaId}: ${r.thumbnailUrl.slice(0, 80)}...`);
}

// Call scrapeReels endpoint with thumbnailUrl included
const resp = await fetch('http://localhost:3000/api/scheduled/scrapeReels', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ reels: allReels }),
});

const text = await resp.text();
console.log('Status:', resp.status);
console.log('Response:', text);
