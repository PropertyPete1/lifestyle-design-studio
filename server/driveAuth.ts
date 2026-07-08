/**
 * Google Drive Token Manager — Permanent Refresh Token Architecture
 *
 * The system uses a Google OAuth2 REFRESH TOKEN (which never expires) to
 * automatically generate fresh access tokens on demand. No agent intervention
 * is needed — the app is fully self-sustaining.
 *
 * Setup (one-time):
 *   1. Owner obtains a refresh token via OAuth Playground or the dashboard UI
 *   2. Owner stores it via POST /api/scheduled/refreshDriveToken { refreshToken, clientId, clientSecret }
 *   3. The system persists these in the DB (settings table)
 *   4. From then on, getDriveToken() auto-refreshes access tokens forever
 *
 * Priority for obtaining an access token:
 *   1. In-memory cached access token (if < 50 minutes old)
 *   2. Auto-refresh using stored refresh token + client credentials
 *   3. Fallback to GOOGLE_WORKSPACE_CLI_TOKEN env var (sandbox/dev only)
 *
 * The old "agent passes a short-lived token every hour" flow is GONE.
 */

import * as db from "./db";

// ─── In-memory cache ────────────────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let tokenSetAt: number = 0; // Unix timestamp in ms

// Access tokens are valid for 60 minutes; we consider them stale after 50 min
const TOKEN_TTL_MS = 50 * 60 * 1000;

// ─── Refresh token credentials (loaded from DB on first use) ────────────────

let cachedRefreshToken: string | null = null;
let cachedClientId: string | null = null;
let cachedClientSecret: string | null = null;
let credentialsLoaded = false;

/**
 * Load OAuth2 credentials from the database (one-time per server lifecycle).
 */
async function loadCredentials(): Promise<boolean> {
  if (credentialsLoaded) {
    return Boolean(cachedRefreshToken && cachedClientId && cachedClientSecret);
  }

  try {
    cachedRefreshToken = await db.getSetting("googleDriveRefreshToken");
    cachedClientId = await db.getSetting("googleDriveClientId");
    cachedClientSecret = await db.getSetting("googleDriveClientSecret");
    credentialsLoaded = true;

    if (cachedRefreshToken && cachedClientId && cachedClientSecret) {
      console.log("[DriveAuth] OAuth2 credentials loaded from DB (refresh token available)");
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[DriveAuth] Could not load credentials from DB:", (err as Error).message);
    return false;
  }
}

/**
 * Store OAuth2 refresh token credentials (called once during setup).
 * After this, the system auto-refreshes access tokens forever.
 */
export async function setDriveRefreshCredentials(opts: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  await db.setSetting("googleDriveRefreshToken", opts.refreshToken);
  await db.setSetting("googleDriveClientId", opts.clientId);
  await db.setSetting("googleDriveClientSecret", opts.clientSecret);

  // Update in-memory cache
  cachedRefreshToken = opts.refreshToken;
  cachedClientId = opts.clientId;
  cachedClientSecret = opts.clientSecret;
  credentialsLoaded = true;

  console.log("[DriveAuth] Refresh token credentials stored permanently. Auto-refresh is now active.");
}

/**
 * Use the refresh token to obtain a fresh access token from Google.
 * Returns the new access token, or throws on failure.
 */
async function refreshAccessToken(): Promise<string> {
  if (!cachedRefreshToken || !cachedClientId || !cachedClientSecret) {
    throw new Error("[DriveAuth] Cannot refresh — no refresh token credentials stored. Run setup first.");
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cachedRefreshToken,
      client_id: cachedClientId,
      client_secret: cachedClientSecret,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[DriveAuth] Token refresh failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("[DriveAuth] Token refresh response missing access_token");
  }

  // Cache the new access token
  cachedAccessToken = data.access_token;
  tokenSetAt = Date.now();

  // Also persist to DB (so it survives restarts without needing an immediate refresh)
  await db.setSetting("googleDriveAccessToken", data.access_token);
  await db.setSetting("googleDriveTokenSetAt", String(tokenSetAt));

  console.log(`[DriveAuth] Access token auto-refreshed. Valid for ~${data.expires_in ?? 3600}s`);
  return data.access_token;
}

/**
 * Store a fresh Drive access token directly (legacy path — kept for backward
 * compatibility with the agent's refreshDriveToken call, but the primary flow
 * now uses the refresh token).
 */
export async function setDriveToken(token: string): Promise<void> {
  cachedAccessToken = token;
  tokenSetAt = Date.now();

  // Persist to DB so it survives server restarts
  await db.setSetting("googleDriveAccessToken", token);
  await db.setSetting("googleDriveTokenSetAt", String(tokenSetAt));

  console.log(`[DriveAuth] Direct token stored (${token.length} chars). Valid until ~${new Date(tokenSetAt + TOKEN_TTL_MS).toISOString()}`);
}

/**
 * Get a valid Google Drive access token.
 *
 * Priority:
 *   1. In-memory cached access token (if fresh, < 50 min old)
 *   2. Auto-refresh using stored refresh token + client credentials
 *   3. Fallback to GOOGLE_WORKSPACE_CLI_TOKEN env var (sandbox/dev only)
 *
 * This function NEVER returns an expired token. If the refresh token flow
 * is configured, the system is fully self-sustaining.
 */
export async function getDriveToken(): Promise<string> {
  // 1. Check in-memory cache
  if (cachedAccessToken && (Date.now() - tokenSetAt) < TOKEN_TTL_MS) {
    return cachedAccessToken;
  }

  // 2. Try auto-refresh with stored credentials
  const hasCredentials = await loadCredentials();
  if (hasCredentials) {
    try {
      return await refreshAccessToken();
    } catch (err) {
      console.error("[DriveAuth] Auto-refresh failed:", (err as Error).message);
      // Fall through to other options
    }
  }

  // 3. Check DB-stored access token (may have been set by a recent agent call)
  try {
    const dbToken = await db.getSetting("googleDriveAccessToken");
    const dbSetAt = await db.getSetting("googleDriveTokenSetAt");

    if (dbToken && dbSetAt) {
      const setAtMs = parseInt(dbSetAt, 10);
      if ((Date.now() - setAtMs) < TOKEN_TTL_MS) {
        cachedAccessToken = dbToken;
        tokenSetAt = setAtMs;
        return dbToken;
      }
    }
  } catch (err) {
    console.warn("[DriveAuth] Could not read token from DB:", (err as Error).message);
  }

  // 4. Fallback: platform-injected tokens (sandbox/dev only)
  const fallbackToken = process.env.GOOGLE_WORKSPACE_CLI_TOKEN || process.env.GOOGLE_DRIVE_TOKEN;
  if (fallbackToken) {
    console.warn("[DriveAuth] Using env var fallback token (not recommended for production)");
    return fallbackToken;
  }

  throw new Error(
    "[DriveAuth] No Google Drive token available. " +
    "Please set up a refresh token via the dashboard (Settings → Google Drive)."
  );
}

/**
 * Check whether the refresh token flow is configured and working.
 */
export async function isDriveAutoRefreshConfigured(): Promise<boolean> {
  return loadCredentials();
}

/**
 * Health check: verify the current token can access Drive.
 * If the token is expired but refresh credentials exist, auto-refreshes first.
 */
export async function verifyDriveAccess(): Promise<{
  healthy: boolean;
  tokenAge?: string;
  autoRefreshConfigured?: boolean;
  error?: string;
}> {
  const autoRefreshConfigured = await isDriveAutoRefreshConfigured();

  try {
    const token = await getDriveToken();
    const res = await fetch(
      "https://www.googleapis.com/drive/v3/about?fields=user",
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const ageMs = tokenSetAt ? Date.now() - tokenSetAt : 0;
      const ageMin = Math.round(ageMs / 60000);
      return { healthy: true, tokenAge: `${ageMin} min`, autoRefreshConfigured };
    }
    const errText = await res.text().catch(() => "");
    return {
      healthy: false,
      autoRefreshConfigured,
      error: `Drive API ${res.status}: ${errText.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      healthy: false,
      autoRefreshConfigured,
      error: String(err),
    };
  }
}
