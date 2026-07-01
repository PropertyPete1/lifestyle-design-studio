import { useEffect, useRef } from "react";

/**
 * Guards against the recurring "stale cached bundle" problem on mobile.
 *
 * The deploy pipeline writes /__manus__/version.json with a fresh `version`
 * (asset hash) on every publish. We record the version seen at first load, then
 * re-check it when the tab regains focus / visibility. If the deployed version
 * has changed, the running bundle is stale — we force a ONE-TIME hard reload so
 * the phone always ends up on the latest build instead of a blank/empty shell.
 *
 * Safeguards:
 * - Only reloads once per changed version (sessionStorage guard) to avoid loops.
 * - Silently no-ops if the version endpoint is unreachable (offline, etc.).
 */
const VERSION_URL = "/__manus__/version.json";
const RELOADED_KEY = "__mns_reloaded_for_version";

async function fetchDeployedVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export function useBuildFreshness() {
  const bootVersion = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Record the version this bundle booted with.
    fetchDeployedVersion().then(v => {
      if (!cancelled) bootVersion.current = v;
    });

    async function checkAndMaybeReload() {
      const current = await fetchDeployedVersion();
      if (!current || !bootVersion.current) return;
      if (current === bootVersion.current) return;

      // Version changed since this bundle loaded -> stale. Reload once.
      const alreadyReloaded = sessionStorage.getItem(RELOADED_KEY);
      if (alreadyReloaded === current) return; // already reloaded for this version
      sessionStorage.setItem(RELOADED_KEY, current);
      window.location.reload();
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        void checkAndMaybeReload();
      }
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
}
