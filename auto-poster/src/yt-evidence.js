/**
 * yt-evidence.js — no gate in this pipeline may fail without leaving behind the
 * data that explains it.
 *
 * THE RULE, AND THE TWO RUNS THAT PAID FOR IT. preserveFailedRender exists
 * because a 55-minute render died with its evidence; run 31766707987 then died
 * at a gate INSIDE the visual build, before the reporting block ever ran, with
 * an error message promising "the per-window reasons are in the stock attempts
 * log above" — and the log contained no such thing, because the reasons only
 * print after the function that threw returns. Thirty-three minutes of ladder
 * decisions, zero artifacts, a diagnosis reduced to guessing.
 *
 * So the render-preservation rule is generalised: every gate writes what it
 * knows BEFORE it throws. JSON goes to the diagnostics directory the workflow
 * already uploads (script-diagnostics, 30 days); video files go to the failed-
 * render directory it also uploads (failed-render, 14 days, stored
 * uncompressed). Neither upload step needed changing — both already tolerate
 * an empty directory, so a run that fails nothing uploads nothing.
 *
 * NEVER THROWS. Evidence-keeping runs on the way to an error that already says
 * what is wrong; a preservation step that threw would replace a useful failure
 * with a confusing one. Errors are returned for the caller to log.
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

import { FAILED_RENDER_DIR } from "./yt-artifact-qc.js";

/** Same resolution writeScriptDiagnostics uses: RUNNER_TEMP on Actions. */
export function evidenceDir() {
  return join(process.env.RUNNER_TEMP || tmpdir(), "yt-diagnostics");
}

/**
 * Keep a gate's evidence: a JSON report, and optionally the media that shows
 * the failure.
 *
 * @param {string} gate    kebab-case gate name; becomes the filename
 * @param {object} data    everything the gate knew when it fired
 * @param {string[]} files media to keep alongside (copied to the failed-render dir)
 * @returns {{ reportPath, copied, errors }}
 */
export function preserveGateEvidence(gate, data, { files = [], log = console.log } = {}) {
  const out = { reportPath: null, copied: [], errors: [] };

  try {
    const dir = evidenceDir();
    mkdirSync(dir, { recursive: true });
    const reportPath = join(dir, `${gate}-${Date.now()}.json`);
    writeFileSync(reportPath, JSON.stringify({ gate, failedAt: new Date().toISOString(), ...data }, null, 2));
    out.reportPath = reportPath;
    log(`[Evidence] ${gate}: report kept at ${reportPath}`);
  } catch (err) {
    out.errors.push(`could not write the ${gate} report: ${err.message}`);
    log(`::warning::could not preserve ${gate} evidence — ${err.message}`);
  }

  for (const file of files) {
    try {
      if (!file || !existsSync(file)) {
        out.errors.push(`${file}: already gone when the gate tried to keep it`);
        continue;
      }
      mkdirSync(FAILED_RENDER_DIR, { recursive: true });
      const dest = join(FAILED_RENDER_DIR, `${gate}-${basename(file)}`);
      copyFileSync(file, dest);
      const mb = Math.round((statSync(dest).size / 1024 / 1024) * 10) / 10;
      out.copied.push(dest);
      log(`[Evidence] ${gate}: kept ${basename(file)} (${mb} MB) — downloadable from the run's artifacts`);
    } catch (err) {
      out.errors.push(`could not copy ${file}: ${err.message}`);
      log(`::warning::could not keep ${file} — ${err.message}`);
    }
  }

  return out;
}

/**
 * Route console.warn onto stdout, prefixed.
 *
 * Both preserved run logs — card 11's and 31766707987's — contain not one of
 * the pipeline's console.warn lines: the rate-limit notice, the stock-lookup
 * failures, the word-timing fallbacks, all invisible. The Actions log pipeline
 * this repo's jobs run under drops the warn channel, and a warning nobody can
 * see is indistinguishable from a warning never raised — which is the exact
 * failure mode "zero silent failures" names.
 *
 * Called at the top of every ENTRYPOINT file — code that executes only when
 * that program is actually run. No library module calls it, and no test
 * imports an entrypoint (verified), so tests that stub console.warn see the
 * console they expect.
 */
export function routeWarnChannel() {
  const warn = (...args) => console.log("[warn]", ...args);
  console.warn = warn;
  return warn;
}
