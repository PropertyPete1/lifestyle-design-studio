#!/usr/bin/env python3
"""
Seed ig_post_history from the MCP result JSON file.
Reads structured data from the MCP tool result and inserts into
ig_post_history via direct DB SQL (using DATABASE_URL env).
"""
import json, sys, os, subprocess
from datetime import datetime, timezone

result_file = sys.argv[1] if len(sys.argv) > 1 else None
if not result_file:
    # Find the most recent MCP result file
    mcp_dir = "/tmp/manus-mcp"
    files = sorted([f for f in os.listdir(mcp_dir) if f.endswith(".json")], reverse=True)
    result_file = os.path.join(mcp_dir, files[0])
    print(f"Using: {result_file}", file=sys.stderr)

with open(result_file) as f:
    data = json.load(f)

# Navigate to the posts array
posts = data.get("result", {}).get("data", [])
print(f"Total posts from API: {len(posts)}", file=sys.stderr)

# Filter to VIDEO posts within last 30 days
now = datetime.now(timezone.utc)
cutoff_ms = int((now.timestamp() - 30 * 86400) * 1000)

ig_posts = []
for p in posts:
    if p.get("media_type") != "VIDEO":
        continue
    ts = p.get("timestamp", "")
    try:
        dt = datetime.fromisoformat(ts.replace("+0000", "+00:00"))
        posted_ms = int(dt.timestamp() * 1000)
    except Exception as e:
        print(f"Skip {p.get('id')}: bad timestamp {ts}: {e}", file=sys.stderr)
        continue
    if posted_ms < cutoff_ms:
        print(f"Skip {p.get('id')}: too old ({ts})", file=sys.stderr)
        continue
    thumb = p.get("thumbnail_url") or p.get("media_url") or ""
    caption = (p.get("caption") or "")[:500]
    ig_posts.append({
        "id": p["id"],
        "thumbnail_url": thumb,
        "caption": caption,
        "posted_ms": posted_ms,
    })

print(f"Recent video posts to seed: {len(ig_posts)}", file=sys.stderr)

# Build SQL INSERT statements
db_url = os.environ.get("DATABASE_URL", "")
if not db_url:
    print("ERROR: DATABASE_URL not set", file=sys.stderr)
    sys.exit(1)

# Parse mysql://user:pass@host:port/db
import re
m = re.match(r"mysql://([^:]+):([^@]+)@([^:/]+):?(\d+)?/(.+)", db_url)
if not m:
    print(f"ERROR: Cannot parse DATABASE_URL: {db_url[:40]}...", file=sys.stderr)
    sys.exit(1)

user, password, host, port, dbname = m.groups()
port = port or "3306"

inserted = 0
skipped = 0
for p in ig_posts:
    thumb = p["thumbnail_url"].replace("'", "\\'")
    caption = p["caption"].replace("'", "\\'").replace("\\", "\\\\")
    sql = (
        f"INSERT INTO ig_post_history (igPostId, thumbnailUrl, captionSnippet, postedAt) "
        f"VALUES ('{p['id']}', '{thumb}', '{caption}', {p['posted_ms']}) "
        f"ON DUPLICATE KEY UPDATE thumbnailUrl=VALUES(thumbnailUrl), captionSnippet=VALUES(captionSnippet), postedAt=VALUES(postedAt);"
    )
    result = subprocess.run(
        ["mysql", "-u", user, f"-p{password}", "-h", host, f"-P{port}", dbname, "-e", sql],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        inserted += 1
        print(f"  Seeded: {p['id']} ({datetime.fromtimestamp(p['posted_ms']/1000, tz=timezone.utc).date()})")
    else:
        skipped += 1
        print(f"  FAILED {p['id']}: {result.stderr[:100]}", file=sys.stderr)

print(f"\nDone: {inserted} seeded, {skipped} failed", file=sys.stderr)
