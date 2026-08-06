/**
 * live-guard.mjs — the latch in front of every script that can change something real.
 *
 * Two incidents came out of scripts in this repo doing exactly what their headers
 * said they would, run by someone who had not read the header first:
 *
 *   - a TikTok post published PUBLIC_TO_EVERYONE, which deleting the Metricool
 *     scheduler entry does NOT retract — it had to be removed by hand in the app;
 *   - a throwaway file left orphaned in the Metricool media library after a
 *     multipart round-trip, because no delete endpoint had been found yet.
 *
 * Neither script was wrong. Neither one asked first. That is the gap this closes.
 *
 * Anything that can reach a live social account, the live media library, the live
 * dashboard, a committed state file, or a real credential calls requireLiveAck()
 * before it does anything else, and names what it touches. Read-only probes do
 * not — a latch on something that changes nothing is noise, and noise is what
 * makes people stop reading latches.
 */

const ACK_VAR = "I_UNDERSTAND_THIS_TOUCHES_LIVE";

/**
 * Refuse to run unless the caller has acknowledged what this script touches.
 *
 * @param {string} touches  What this script changes, in plain words. Shown to
 *                          whoever just tried to run it, so be specific: name the
 *                          account, the file, or the endpoint, and say what cannot
 *                          be undone.
 */
export function requireLiveAck(touches) {
  if (process.env[ACK_VAR] === "yes") return;

  console.error(
    `\n  REFUSING TO RUN — this script touches a live system.\n\n` +
      `  ${touches}\n\n` +
      `  If that is what you want, run it again with:\n\n` +
      `      ${ACK_VAR}=yes node ${process.argv[1] ?? "<script>"}\n`
  );
  process.exit(1);
}
