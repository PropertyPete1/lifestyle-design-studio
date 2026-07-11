# Lifestyle Design Realty — Auto Poster

Fully automated social media reposting system. Runs on GitHub Actions with zero manual steps after setup.

## What It Does

Every day, this system:
1. **Checks your Instagram** (via Metricool) for what you've posted in the last 30 days
2. **Picks a video from Google Drive** that hasn't been posted recently (30-day rotation)
3. **Detects if the video has speech** — if not, generates and adds a voiceover (ElevenLabs)
4. **Generates a fresh caption** using AI (Claude)
5. **Posts to all platforms** via Metricool: Instagram, TikTok, YouTube, Facebook
6. **Logs the result** to `posted-log.json` (committed back to the repo)

## Schedule

| City | Time (CT) | Frequency |
|------|-----------|-----------|
| San Antonio | 2:00 PM | Daily |
| Austin | 3:00 PM | Daily |
| Dallas/DFW | 4:00 PM | Every other day |

## Setup Checklist

### 1. GitHub Secrets

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Description |
|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret |
| `GOOGLE_REFRESH_TOKEN` | Google Drive refresh token (see step 2) |
| `METRICOOL_API_TOKEN` | Metricool API token |
| `METRICOOL_BLOG_ID` | Metricool blog/brand ID (`4807109`) |
| `METRICOOL_USER_ID` | Metricool user ID (`3748462`) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key for voiceovers |
| `ANTHROPIC_API_KEY` | Anthropic API key for caption generation |

### 2. Get Your Google Refresh Token

Run this locally (one time only):

```bash
cd auto-poster
npm install
node scripts/get-refresh-token.js
```

It opens a browser, you authorize, and it prints the refresh token. Paste it into GitHub Secrets.

### 3. Google Cloud App Status (CRITICAL)

Your Google OAuth app **must be in "Production" mode** (not "Testing"):
- Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials/consent)
- Check the "Publishing status" — it should say **"In production"**
- If it says "Testing", click "Publish App" — otherwise your refresh token expires in 7 days

### 4. Drive Folder Structure

The system expects these folders in your Google Drive:
- **San Antonio New** (ID: `1O5lL5rWjuzj3kg5kRMqY7E4CdcnDz4bY`)
- **Austin New** (ID: `1GgKKUJFzV39JQ3oTRoe7aTdZwqqMbba8`)
- **DFW New** (ID: `1nNrGjhHeMG3B25Cj3o7T2cLRAJM-9RX2`)

To change folder IDs, edit `src/drive.js` → `CITY_FOLDER_IDS`.

## Manual Trigger

You can trigger a post manually from the **Actions** tab:
1. Go to Actions → "Daily Auto Post"
2. Click "Run workflow"
3. Select city and optionally enable dry-run

## Dry Run

Test without actually posting:

```bash
cd auto-poster
DRY_RUN=true CITY=san_antonio \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
  METRICOOL_API_TOKEN=... METRICOOL_BLOG_ID=4807109 METRICOOL_USER_ID=3748462 \
  ELEVENLABS_API_KEY=... ANTHROPIC_API_KEY=... \
  node src/main.js
```

Or trigger via GitHub Actions with the "Dry run" checkbox.

## How Rotation Works

- Each city's Drive folder contains all available videos
- `posted-log.json` tracks which videos were posted and when
- A video becomes eligible again after 30 days
- If a video fails to download, the system tries the next candidate (up to 3)
- The idempotency guard prevents double-posting if the cron fires twice

## Changing the Schedule

Edit `.github/workflows/post.yml`:
- Cron times are in UTC (CT + 5 hours, or +6 during standard time)
- Current: `0 19 * * *` = 2PM CT (during CDT)
- To change to 3PM CT: `0 20 * * *`

## Costs

- **Anthropic (Claude Haiku)**: ~$0.01/post for captions + voiceover scripts
- **ElevenLabs**: ~$0.05/post for TTS (only when video needs voiceover)
- **GitHub Actions**: Free (runs ~2-5 min per post, well within free tier)
- **Total**: ~$3-5/month for all 3 cities

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "No Google Drive token" | Refresh token expired — re-run `get-refresh-token.js` |
| "All videos posted in 30 days" | Add more videos to the Drive folder |
| "Metricool upload failed" | Check API token is valid |
| Double-posted | The 20-hour guard should prevent this; check `posted-log.json` |
| DFW posting daily | Check the day-of-year even/odd logic in workflow |
