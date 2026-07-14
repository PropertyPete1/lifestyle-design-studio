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
 * 4. You paste it into GitHub Secrets as GOOGLE_REFRESH_TOKEN
 *
 * NOTE: Your OAuth app is Internal, so no re-verification needed.
 * The old readonly token will stop working once you replace the secret.
 */

import http from "http";
import { URL } from "url";
import { exec } from "child_process";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "1014621141316-fs30p38fo8a99gs6ggufu5hf39vb0e3q.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "GOCSPX-6xA1ZbsFEtaV4uQlEvzvDkqCJ5B";
const REDIRECT_URI = "http://localhost:3847/callback";
const SCOPES = [
  "https://www.googleapis.com/auth/drive",       // Full Drive access (read + write + delete)
  "https://www.googleapis.com/auth/gmail.send",   // Send email only (not read inbox)
].join(" ");

async function main() {
  console.log("=".repeat(60));
  console.log("Google OAuth Refresh Token Generator (Drive + Gmail Send)");
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
  console.log("2. Add a new secret: GOOGLE_REFRESH_TOKEN");
  console.log("3. Paste the token above as the value");
  console.log("");
  console.log("IMPORTANT: Your OAuth app is Internal — no re-verification needed.");
  console.log("The new token grants: drive (full) + gmail.send.");
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
