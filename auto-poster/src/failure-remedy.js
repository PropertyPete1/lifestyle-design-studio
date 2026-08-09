/**
 * failure-remedy.js — turn an error into the sentence that fixes it.
 *
 * An alert that says "ElevenLabs TTS failed (403)" is a diagnosis. Peter reading
 * it at 7am needs the next line: whose account, which knob, what to change. The
 * 2026-07-27 outage ran for fourteen days partly because nothing anywhere said
 * "your ElevenLabs plan no longer covers this voice" — the information was in a
 * JSON blob inside a stack trace inside a step log.
 *
 * These are deliberately specific. A generic "check the logs" remedy is worse
 * than none, because it trains the reader to skip the field.
 *
 * Matching is on message text because that is all an API client gets. Each rule
 * is anchored on a string the provider actually returns, and there is a test
 * pinning the real 403 body from the outage so a reworded rule cannot silently
 * stop matching.
 */

const RULES = [
  {
    id: "elevenlabs_voice_tier",
    // The exact shape ElevenLabs returned throughout the July/August outage.
    match: (m) => /elevenlabs/i.test(m) && /403/.test(m) && /subscription_required|only_for_creator|Professional voices/i.test(m),
    remedy:
      "The ElevenLabs account no longer has access to the cloned Professional voice.\n" +
      "Either (a) restore the Creator-tier subscription on the ElevenLabs account, or\n" +
      "(b) set the ELEVENLABS_VOICE_ID repository secret to a standard voice id — the\n" +
      "code reads it and needs no deploy. Until one of those happens, every reel whose\n" +
      "source video has no real speech, and EVERY trial variant, will keep failing.",
  },
  {
    id: "elevenlabs_auth",
    match: (m) => /elevenlabs/i.test(m) && /(401|invalid_api_key|unauthorized)/i.test(m),
    remedy: "The ELEVENLABS_API_KEY secret is missing, expired or revoked. Reissue it in the ElevenLabs dashboard and update the repository secret.",
  },
  {
    id: "elevenlabs_quota",
    match: (m) => /elevenlabs/i.test(m) && /(429|quota|rate.?limit|too many requests)/i.test(m),
    remedy: "The ElevenLabs character quota or rate limit is exhausted. Check usage on the account; the next scheduled slot will retry on its own once it resets.",
  },
  {
    id: "google_oauth",
    match: (m) => /(refresh Google token|Missing Google OAuth|invalid_grant)/i.test(m),
    remedy:
      "The Google refresh token is dead — this breaks Drive downloads, owner delivery AND these alert emails.\n" +
      "Re-run `npm run get-token` in auto-poster/ and update the GOOGLE_REFRESH_TOKEN secret.",
  },
  {
    id: "gmail_scope",
    match: (m) => /Gmail API 40[13]/i.test(m),
    remedy: "The Google token lacks the gmail.send scope, so email alerts cannot be sent. Re-run the token script and approve the Gmail scope.",
  },
  {
    id: "metricool_auth",
    match: (m) => /metricool/i.test(m) && /(401|403|invalid|unauthorized)/i.test(m),
    remedy: "Metricool rejected the credentials. Check METRICOOL_API_TOKEN / METRICOOL_BLOG_ID / METRICOOL_USER_ID against the Metricool account.",
  },
  {
    id: "anthropic",
    match: (m) => /(anthropic|claude)/i.test(m) && /(401|403|429|credit|quota|overloaded)/i.test(m),
    remedy: "The Anthropic API rejected or throttled the request — captions, carousel copy and voiceover scripts all depend on it. Check the API key and the account's credit balance.",
  },
  {
    id: "drive_pool",
    match: (m) => /No videos found in Drive|no eligible source|All videos for .* have been posted/i.test(m),
    remedy: "The candidate pool is empty. Add fresh clips to the city's Drive folder, or clear stale entries from qc-blocklist.json / skip-list.json.",
  },
];

/**
 * The remedy for an error, or null when we genuinely do not know.
 *
 * Returning null is correct and expected — a made-up remedy is worse than an
 * honest absence, because the reader will act on it.
 */
export function remedyFor(err) {
  const msg = typeof err === "string" ? err : err?.message || "";
  if (!msg) return null;
  for (const rule of RULES) {
    if (rule.match(msg)) return rule.remedy;
  }
  return null;
}

/** The rule that matched, for tests and for logging which branch fired. */
export function remedyIdFor(err) {
  const msg = typeof err === "string" ? err : err?.message || "";
  if (!msg) return null;
  return RULES.find((r) => r.match(msg))?.id || null;
}

export const REMEDY_RULE_IDS = RULES.map((r) => r.id);
