/**
 * One-time setup script to get a Google OAuth refresh token.
 * 
 * Scopes requested:
 *   - drive (full read/write — needed for uploading to "Ready to Post" folder)
 *   - gmail.send (send-only — needed for email backup channel on delivery)
 * 
 * Run this locally: node scripts/get-refresh-token.js
 * 
 * It will:
 * 1. Open a browser to Google's OAuth consent page
 * 2. You authorize Drive + Gmail Send access
 * 3. It prints the refresh token
 * 4. You paste it into GitHub Secrets — GOOGLE_REFRESH_TOKEN by default,
 *    or YT_REFRESH_TOKEN when run with --youtube
 *
 * Two modes, two secrets:
 *   node scripts/get-refresh-token.js             Drive + Gmail  -> GOOGLE_REFRESH_TOKEN
 *   node scripts/get-refresh-token.js --youtube   thumbnails     -> YT_REFRESH_TOKEN
 *
 * NOTE: Your OAuth app is Internal, so no re-verification needed.
 * The old readonly token will stop working once you replace the secret.
 */

import http from "http";
import { URL } from "url";
import { exec } from "child_process";
import { requireLiveAck } from "./live-guard.mjs";

/**
 * Two tokens, two secrets, deliberately never combined.
 *
 * The default mints the Drive + Gmail token every scheduled job runs on.
 * `--youtube` mints a SEPARATE token carrying only youtube.force-ssl, for
 * thumbnails.set and nothing else.
 *
 * They are kept apart because the blast radius differs. Pasting a
 * YouTube-scoped token into GOOGLE_REFRESH_TOKEN would silently break Drive and
 * Gmail for every job in this repo, and the first symptom would be a posting
 * run failing hours later. So the two modes name different secrets, print
 * different banners, and the script says which one it just made.
 */
const TOKEN_SETS = {
  default: {
    label: "Drive + Gmail Send",
    secret: "GOOGLE_REFRESH_TOKEN",
    scopes: [
      "https://www.googleapis.com/auth/drive",      // Full Drive access (read + write + delete)
      "https://www.googleapis.com/auth/gmail.send", // Send email only (not read inbox)
    ],
    warning: "This replaces the token EVERY scheduled job uses. Do it deliberately.",
  },
  youtube: {
    label: "YouTube (thumbnails only)",
    secret: "YT_REFRESH_TOKEN",
    // force-ssl is the narrowest scope that grants thumbnails.set. There is no
    // thumbnail-only scope. It does grant more than we use — which is exactly
    // why this token lives in its own secret and is read by one call site.
    scopes: ["https://www.googleapis.com/auth/youtube.force-ssl"],
    warning:
      "Publishing stays with Metricool. This token is for thumbnails.set only —\n" +
      "  it is NOT used to upload, publish, or change any video's privacy.",
  },
};

const MODE = process.argv.includes("--youtube") ? "youtube" : "default";
const TOKEN_SET = TOKEN_SETS[MODE];
const SCOPES = TOKEN_SET.scopes.join(" ");

// TOUCHES LIVE: runs a real Google OAuth consent flow and mints a live refresh
// token, printed to the terminal. Which token depends on the mode — see
// TOKEN_SETS above. Replacing GOOGLE_REFRESH_TOKEN INVALIDATES the token every
// scheduled job currently uses; YT_REFRESH_TOKEN is separate and affects only
// the thumbnail call.
requireLiveAck(
  `Mints a live Google refresh token (${TOKEN_SET.label}) and prints it, for the ` +
    `${TOKEN_SET.secret} secret. ${TOKEN_SET.warning}`
);

// SECURITY: never hardcode credentials here. This file is committed to a PUBLIC repo.
// Supply both values via environment variables when running the script:
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.js
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the environment.");
  console.error("Get them from Google Cloud Console → APIs & Services → Credentials.");
  process.exit(1);
}
const REDIRECT_URI = "http://localhost:3847/callback";



async function main() {
  console.log("=".repeat(60));
  console.log(`Google OAuth Refresh Token Generator (${TOKEN_SET.label})`);
  console.log("=".repeat(60));
  console.log("");

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  console.log("Opening browser for authorization...");
  console.log("");
  console.log("If the browser doesn't open, visit this URL:");
  console.log(authUrl);
  console.log("");

  // Try to open browser
  const openCmd = process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  exec(`${openCmd} "${authUrl}"`);

  // Start local server to catch the callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:3847`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>✓ Authorization successful!</h1><p>You can close this tab.</p>");
          resolve(code);
        } else {
          const error = url.searchParams.get("error");
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Error: ${error}</h1>`);
          reject(new Error(error));
        }
        server.close();
      }
    });
    server.listen(3847, () => {
      console.log("Waiting for authorization...");
    });
    setTimeout(() => {
      server.close();
      reject(new Error("Timeout — no authorization received in 5 minutes"));
    }, 300000);
  });

  console.log("\nAuthorization code received! Exchanging for refresh token...\n");

  // Exchange code for tokens
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Token exchange failed:", err);
    process.exit(1);
  }

  const tokens = await res.json();

  if (!tokens.refresh_token) {
    console.error("No refresh token returned! Make sure you used prompt=consent.");
    console.error("Response:", JSON.stringify(tokens, null, 2));
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log("SUCCESS! Here is your refresh token:");
  console.log("=".repeat(60));
  console.log("");
  console.log(tokens.refresh_token);
  console.log("");
  console.log("=".repeat(60));
  console.log("");
  console.log("Next steps:");
  console.log("1. Go to: https://github.com/PropertyPete1/lifestyle-design-studio/settings/secrets/actions");
  console.log(`2. Add a new secret: ${TOKEN_SET.secret}`);
  console.log("3. Paste the token above as the value");
  console.log("");
  console.log("IMPORTANT: Your OAuth app is Internal — no re-verification needed.");
  console.log(`This token grants ONLY: ${TOKEN_SET.scopes.join(", ")}`);
  if (MODE === "youtube") {
    console.log("");
    console.log("Do NOT paste this into GOOGLE_REFRESH_TOKEN — it has no Drive or Gmail");
    console.log("access, and every scheduled job in this repo would start failing.");
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
