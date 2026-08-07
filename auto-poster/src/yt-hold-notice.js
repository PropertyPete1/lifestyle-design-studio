/**
 * yt-hold-notice.js — telling Peter that a script was held back.
 *
 * A script that scores below the bar is discarded and the request is left
 * unacted, so the next poll tries again. That behaviour is right: a weak script
 * must never become a recording session, and re-running is free where
 * re-recording is not.
 *
 * What was wrong is that it happened in silence. The pipeline logged a
 * `::warning::` into an Actions log nobody watches and returned. Peter picked a
 * topic, waited over an hour, and had no way to learn that a script had been
 * written, judged, and held — the system looked identical to one that had
 * simply not run. Silence is indistinguishable from failure, so it must not be
 * an outcome.
 *
 * This module renders that hold as a notification. Pure functions only: the
 * pipeline owns the sending, and these own what it says — which is what makes
 * the wording testable without a network.
 *
 * It is deliberately NOT an approval request. Peter has nothing to decide here;
 * the retry is automatic. It travels on the same channel as everything else and
 * reuses the request's existing id, exactly as the recording kit does, so no new
 * approval record is created — one of those would look like an unanswered brief
 * and block the next Monday brief from going out.
 */

/** Matches PASS_MARK in yt-script.js — shown so the numbers explain themselves. */
const BAR = 8;

const AXES = ["clarity", "retention", "authenticity"];

/**
 * The structured half, for the dashboard.
 *
 * `stage: "held_below_bar"` mirrors the recording kit's `stage: "recording_kit"`
 * — a stage update on an existing request, not a new question.
 */
export function heldBackPayload({ requestId, topicTitle, scriptResult, why }) {
  const scores = scriptResult?.scores || {};
  return {
    stage: "held_below_bar",
    requestId,
    topicTitle: topicTitle || null,
    scriptTitle: scriptResult?.title || null,
    why: why || null,
    bar: BAR,
    scores: {
      clarity: scores.clarity ?? null,
      retention: scores.retention ?? null,
      authenticity: scores.authenticity ?? null,
    },
    failingAxes: AXES.filter((a) => typeof scores[a] === "number" && scores[a] < BAR),
    critic: {
      worstProblem: scores.worst_problem || null,
      worstBoundary: scores.worst_boundary || null,
      fix: scores.fix || null,
    },
    criticUnavailable: Boolean(scriptResult?.criticUnavailable),
    attemptsUsed: scriptResult?.attemptsUsed ?? null,
    draft: {
      takeCount: scriptResult?.takeCount ?? null,
      onCameraCount: scriptResult?.onCameraCount ?? null,
      estimatedMinutes: scriptResult?.estimatedMinutes ?? null,
    },
    retrying: true,
  };
}

/**
 * The readable half, for email.
 *
 * Written to be understood on a phone, by someone who is not at a computer and
 * did not ask for a status report. It leads with the fact that nothing is
 * required of him, because the first question a held-back notice raises is
 * "do I need to do something about this".
 */
export function renderHeldBackText({ topicTitle, scriptResult, why, runUrl = null }) {
  const scores = scriptResult?.scores || {};
  const lines = [];

  lines.push(`SCRIPT HELD BACK — ${scriptResult?.title || topicTitle || "untitled"}`);
  lines.push("");
  lines.push("No recording kit was sent. Nothing is needed from you — the next");
  lines.push("scheduled poll writes a fresh draft and tries again automatically.");
  lines.push("");

  if (scriptResult?.criticUnavailable) {
    lines.push("WHY: the critic could not be reached, so nothing scored this script.");
    lines.push("A script nobody judged is never sent to be recorded.");
  } else {
    lines.push(`WHY: it scored below the bar of ${BAR}.`);
    lines.push("");
    for (const axis of AXES) {
      const v = scores[axis];
      const mark = typeof v === "number" && v < BAR ? "  <- below" : "";
      lines.push(`  ${axis.padEnd(14)}${v ?? "?"} / ${BAR}${mark}`);
    }
  }
  lines.push("");

  if (scores.worst_problem || scores.worst_boundary || scores.fix) {
    lines.push("WHAT THE CRITIC SAID");
    if (scores.worst_problem) lines.push("", `  Worst problem:  ${scores.worst_problem}`);
    if (scores.worst_boundary) lines.push("", `  Weakest seam:   ${scores.worst_boundary}`);
    if (scores.fix) lines.push("", `  Suggested fix:  ${scores.fix}`);
    lines.push("");
  }

  if (topicTitle) lines.push(`Topic you picked: ${topicTitle}`);
  // NOT "attempts". yt-script.js counts this off `attempts`, which only collects
  // drafts that got far enough to be SCORED — a draft that failed structure
  // validation or came back as unparseable JSON never lands there. Labelling it
  // "attempts used: 1" on a run that burned three would read as a clean first
  // pass. The run log is the place to see every attempt.
  if (scriptResult?.attemptsUsed) lines.push(`Drafts scored:    ${scriptResult.attemptsUsed}`);
  if (scriptResult?.takeCount) {
    lines.push(
      `Draft:            ${scriptResult.takeCount} takes ` +
        `(${scriptResult.onCameraCount ?? "?"} on camera), about ${scriptResult.estimatedMinutes ?? "?"} min`
    );
  }

  lines.push("");
  lines.push(
    runUrl
      ? `The full draft is attached to that run as a "script-diagnostics" artifact:\n${runUrl}`
      : 'The full draft is attached to the GitHub Actions run as a "script-diagnostics" artifact.'
  );

  return lines.join("\n");
}

/** Subject line. Front-loads the verdict — it may be all he reads. */
export function heldBackSubject({ topicTitle, scriptResult }) {
  const title = scriptResult?.title || topicTitle || "script";
  if (scriptResult?.criticUnavailable) return `Script held back (unscored) — ${title}`;
  const s = scriptResult?.scores || {};
  return `Script held back (${s.clarity}/${s.retention}/${s.authenticity}) — ${title}`;
}

// ─── the other silence: no draft survived format validation at all ───────────

/**
 * When every attempt fails validation, generateScript throws and the run exits
 * red before the below-bar notice is ever reached. All Peter gets is a GitHub
 * "workflow failed" mail, which does not say that a script was attempted, let
 * alone why it did not survive. Same silence, different door.
 */
export function noDraftPayload({ requestId, topicTitle, attemptFailures = [] }) {
  return {
    stage: "no_usable_draft",
    requestId,
    topicTitle: topicTitle || null,
    attempts: attemptFailures.length,
    failures: attemptFailures.map((f) => ({
      attempt: f.attempt,
      kind: f.kind,
      detail: f.kind === "structure" ? (f.failures || []).join("; ") : f.message || null,
    })),
    retrying: true,
  };
}

export function noDraftSubject({ topicTitle, attemptFailures = [] }) {
  return `No usable script after ${attemptFailures.length} attempts — ${topicTitle || "your topic"}`;
}

export function renderNoDraftText({ topicTitle, attemptFailures = [], runUrl = null }) {
  const lines = [];
  lines.push(`NO USABLE SCRIPT — ${topicTitle || "your topic"}`);
  lines.push("");
  lines.push("Every attempt failed format validation before it could be scored, so");
  lines.push("nothing was judged and no kit was sent. Nothing is needed from you —");
  lines.push("the next scheduled poll tries again automatically.");
  lines.push("");
  lines.push("This is a writing-format problem on our side, not a problem with your");
  lines.push("topic. The pick and your notes are untouched.");
  lines.push("");

  if (attemptFailures.length) {
    lines.push("WHAT FAILED");
    for (const f of attemptFailures) {
      const detail =
        f.kind === "structure" ? (f.failures || []).join("; ") : f.message || "unparseable output";
      lines.push("", `  Attempt ${f.attempt} — ${f.kind}: ${detail}`);
    }
    lines.push("");
  }

  lines.push(
    runUrl
      ? `Full detail, including the raw output where it broke, is attached to that\nrun as a "script-diagnostics" artifact:\n${runUrl}`
      : 'Full detail is attached to the GitHub Actions run as a "script-diagnostics" artifact.'
  );
  return lines.join("\n");
}
