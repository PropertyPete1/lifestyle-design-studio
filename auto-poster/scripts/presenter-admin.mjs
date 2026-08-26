#!/usr/bin/env node
/**
 * presenter-admin.mjs — the one validated entry point for presenter state.
 *
 *   node scripts/presenter-admin.mjs add    "Name <email>" [role]
 *   node scripts/presenter-admin.mjs assign "<name|email|Name <email>>" "<requestId|videoId|next>"
 *   node scripts/presenter-admin.mjs rotate "<name|email|id>"
 *   node scripts/presenter-admin.mjs list
 *
 * Driven by the presenters.yml workflow so every authorized caller — Peter on
 * the Actions page today, PRIMARY over the REST API later — comes through the
 * same validation. Nothing here trusts its inputs:
 *
 *   - an UNKNOWN presenter in an assignment is added only when the input
 *     carries the full "Name <email>" form — an explicit instruction to add.
 *     A bare unknown name is refused with what to do instead. NOTHING ever
 *     silently defaults to the owner.
 *   - reassigning a request whose kit already went out supersedes it LOUDLY:
 *     the stored script is adapted for the new presenter, swept for owner
 *     claims, re-scored by the full critic, delivered to the new presenter,
 *     and the old presenter is told their kit is dead. Two live kits for one
 *     video is a state this script cannot produce.
 *
 * DRY_RUN=true walks every path and sends nothing, writes nothing.
 */

import { requireLiveAck } from "./live-guard.mjs";
import {
  loadPresenters,
  savePresenters,
  addPresenter,
  rotateAccessCode,
  resolvePresenter,
  parseAssignee,
  setNextAssignment,
  presenterStamp,
  ROLE_GUEST,
  ROLES,
} from "../src/presenters.js";
import {
  loadApprovals,
  saveApprovals,
  findRequest,
  setRequestPresenter,
  updateActedScript,
  hasActed,
} from "../src/yt-approvals.js";
import { loadLog as loadVideoLog, findVideo } from "../src/yt-log.js";
import { adaptScriptForPresenter, vetAdaptedScript } from "../src/presenter-script.js";
import { deliverKit, sendSupersessionNotice, assertAssignable } from "../src/kit-delivery.js";
import { sendPresenterEmail } from "../src/delivery.js";
import { getAccessToken } from "../src/drive.js";
import { ensureRecordingsFolder } from "../src/yt-ingest.js";
import { routeWarnChannel } from "../src/yt-evidence.js";
routeWarnChannel();

const DRY_RUN = process.env.DRY_RUN === "true";

const [action, arg1, arg2] = process.argv.slice(2).map((s) => String(s || "").trim());

function fail(reason) {
  console.error(`[PresenterAdmin] REFUSED: ${reason}`);
  process.exit(1);
}

/** A code is a login; logs are not an inbox. Enough to confirm, not to use. */
const maskCode = (code) => (code ? `${String(code).slice(0, 2)}****` : "(none)");

// ─── list — read-only, no live ack ──────────────────────────────────────────

if (action === "list") {
  const registry = loadPresenters();
  for (const p of registry.presenters) {
    console.log(
      `  ${p.id}  ${p.name} <${p.email}>  role=${p.role}${p.test ? " TEST" : ""}  ` +
        `code=${maskCode(p.accessCode)} (issued ${p.codeIssuedAt})`
    );
  }
  const na = registry.nextAssignment;
  console.log(
    na
      ? na.consumedAt
        ? `  next: ${na.presenterId} — CONSUMED by ${na.consumedBy} at ${na.consumedAt}`
        : `  next: ${na.presenterId} — standing since ${na.assignedAt}`
      : "  next: none"
  );
  process.exit(0);
}

if (!["add", "assign", "rotate"].includes(action)) {
  fail(`unknown action "${action}" — use add, assign, rotate, or list`);
}

// TOUCHES LIVE: writes presenters.json / yt-approvals.json (committed as
// state every scheduled job trusts) and can send real kit and code emails.
if (!DRY_RUN) {
  requireLiveAck(
    "Writes presenter registry state that every scheduled job trusts, and can send " +
      "real recording-kit and access-code emails to real inboxes."
  );
}

async function main() {
  const registry = loadPresenters();

  // ── add ───────────────────────────────────────────────────────────────────
  if (action === "add") {
    const { name, email } = parseAssignee(arg1);
    if (!name || !email) fail(`add needs the full form: "Name <email>" — got "${arg1}"`);
    const role = arg2 || ROLE_GUEST;
    if (!ROLES.includes(role)) fail(`role must be one of ${ROLES.join("/")}, got "${role}"`);
    const added = addPresenter(registry, { name, email, role });
    if (!added.ok) fail(added.reason);
    console.log(
      `[PresenterAdmin] added ${added.presenter.id}: ${added.presenter.name} <${added.presenter.email}> ` +
        `role=${role}${added.presenter.test ? " TEST (mail will be suppressed)" : ""} code=${maskCode(added.presenter.accessCode)}`
    );
    if (DRY_RUN) return console.log("[PresenterAdmin] DRY RUN — nothing written");
    savePresenters(added.registry);
    console.log("[PresenterAdmin] ✓ presenters.json updated — their code goes out with their first kit");
    return;
  }

  // ── rotate ────────────────────────────────────────────────────────────────
  if (action === "rotate") {
    if (!arg1) fail("rotate needs a presenter (name, email, or id)");
    const rotated = rotateAccessCode(registry, arg1);
    if (!rotated.ok) fail(rotated.reason);
    console.log(
      `[PresenterAdmin] rotating ${rotated.presenter.id}: ${maskCode(rotated.oldCode)} -> ${maskCode(rotated.presenter.accessCode)} ` +
        `(the old code is retired and can never be reissued)`
    );
    if (DRY_RUN) return console.log("[PresenterAdmin] DRY RUN — nothing written, nothing sent");
    savePresenters(rotated.registry);
    const accessToken = await getAccessToken().catch(() => null);
    const sent = await sendPresenterEmail(accessToken, {
      presenter: rotated.presenter,
      subject: "Your recorder access code changed",
      body: [
        `Hi ${rotated.presenter.name.split(/\s+/)[0]},`,
        "",
        `Your access code for the Lifestyle Design Realty recorder is now: ${rotated.presenter.accessCode}`,
        `The old code no longer works. It's yours alone; don't share it.`,
      ].join("\n"),
    });
    if (!sent.ok) {
      // The rotation stands — the old code is dead either way — but a
      // presenter who cannot log in and does not know why is a silent
      // failure, so this run goes red for it.
      throw new Error(`code rotated but the new code did not reach ${rotated.presenter.email}: ${sent.lastError?.message}`);
    }
    console.log(`[PresenterAdmin] ✓ new code ${sent.suppressed ? "suppressed (TEST presenter)" : `sent to ${rotated.presenter.email}`}`);
    return;
  }

  // ── assign ────────────────────────────────────────────────────────────────
  if (!arg1 || !arg2) fail('assign needs a presenter and a target: assign "<who>" "<requestId|videoId|next>"');

  // Resolve — or add — the presenter. The add-if-unknown door only opens for
  // the full "Name <email>" form, because that is the only input that could
  // not be a typo for somebody who already exists.
  const parsed = parseAssignee(arg1);
  let reg = registry;
  let presenter = null;
  const resolved = resolvePresenter(reg, parsed.email || parsed.name || arg1);
  if (resolved.ok) {
    presenter = resolved.presenter;
    if (parsed.email && parsed.name && presenter.name.toLowerCase() !== parsed.name.toLowerCase()) {
      fail(
        `${parsed.email} belongs to "${presenter.name}", not "${parsed.name}" — ` +
          `refusing an ambiguous assignment. Use just the email, or fix the name.`
      );
    }
  } else if (resolved.unknown && parsed.name && parsed.email) {
    const added = addPresenter(reg, { name: parsed.name, email: parsed.email, role: ROLE_GUEST });
    if (!added.ok) fail(added.reason);
    reg = added.registry;
    presenter = added.presenter;
    console.log(
      `[PresenterAdmin] "${parsed.name}" was unknown — ADDED as ${presenter.id} <${presenter.email}> (guest), then assigning`
    );
  } else if (resolved.unknown) {
    fail(
      `${resolved.reason}. To add-and-assign in one move, pass the full form: "Name <email>". ` +
        `Never assuming you meant the owner — say who you meant.`
    );
  } else {
    fail(resolved.reason);
  }

  // ── target: the standing "next" assignment ───────────────────────────────
  if (arg2.toLowerCase() === "next") {
    const set = setNextAssignment(reg, presenter.id);
    if (!set.ok) fail(set.reason);
    if (set.previous) {
      console.log(`[PresenterAdmin] REPLACING the standing assignment to "${set.previous.presenterId}" (set ${set.previous.assignedAt})`);
    }
    console.log(`[PresenterAdmin] the NEXT Monday brief's video is ${presenter.name}'s (${presenter.id})`);
    if (DRY_RUN) return console.log("[PresenterAdmin] DRY RUN — nothing written");
    savePresenters(set.registry);
    console.log("[PresenterAdmin] ✓ standing assignment recorded — consumed by the next brief, exactly once");
    return;
  }

  // ── target: an existing request or video ─────────────────────────────────
  const approvals = loadApprovals();
  let requestId = arg2;
  let record = findRequest(approvals, requestId);
  if (!record) {
    // Maybe they named the video instead of the request.
    const video = findVideo(loadVideoLog(), arg2);
    if (video?.requestId) {
      requestId = video.requestId;
      record = findRequest(approvals, requestId);
      if (record) console.log(`[PresenterAdmin] ${arg2} -> request ${requestId}`);
    }
  }
  if (!record) fail(`"${arg2}" matches no requestId in yt-approvals.json and no videoId in youtube-log.json — check for typos`);

  const assignable = assertAssignable(presenter, requestId);
  if (!assignable.ok) fail(assignable.reason);

  const stamp = presenterStamp(presenter);
  const stamped = setRequestPresenter(approvals, requestId, stamp);
  if (!stamped.ok) fail(stamped.reason);
  const previous = stamped.previous;

  const kitOut = hasActed(record) && record.actedResult?.script;
  if (!kitOut) {
    // No kit yet: the stamp is the whole job. The pipeline generates the
    // script presenter-aware when the topic is approved (or builds from it if
    // already approved and unacted next run).
    console.log(
      `[PresenterAdmin] ${requestId} assigned to ${presenter.name}` +
        (previous ? ` (was ${previous.id})` : "") +
        ` — no kit is out yet, so the pipeline will generate presenter-aware from here`
    );
    if (DRY_RUN) return console.log("[PresenterAdmin] DRY RUN — nothing written");
    savePresenters(reg);
    saveApprovals(stamped.log);
    console.log("[PresenterAdmin] ✓ assignment recorded");
    return;
  }

  // ── reassignment after delivery: supersede loudly ────────────────────────
  console.log(
    `[PresenterAdmin] ${requestId} already has a delivered kit` +
      (previous ? ` (presenter ${previous.id})` : " (owner's, pre-presenter-system)") +
      ` — superseding it for ${presenter.name}`
  );

  // 1. Adapt the DELIVERED script — the approved words, not a rewrite.
  const adapted = adaptScriptForPresenter(record.actedResult.script, presenter);
  if (adapted.unresolved.length > 0) {
    fail(
      `the stored script still claims Peter's identity after neutralization — ` +
        adapted.unresolved.map((u) => `${u.where}: "${u.match}"`).join("; ") +
        `. Nothing was sent. This script needs a regeneration, not a reassignment.`
    );
  }
  if (adapted.changes.length > 0) {
    console.log(
      `[PresenterAdmin] neutralized ${adapted.changes.length} owner claim(s): ` +
        adapted.changes.map((c) => `${c.where} "${c.from}" -> "${c.to}"`).join("; ")
    );
  } else if (adapted.adapted) {
    console.log("[PresenterAdmin] sweep found nothing to neutralize");
  }

  // 2. Re-run the full critic over anything the sweep changed. Skipped in a
  //    dry run (a dry run must not bill the model) and said so.
  if (adapted.adapted && adapted.changes.length > 0) {
    if (DRY_RUN) {
      console.log("[PresenterAdmin] DRY RUN — critic re-score skipped (would run live)");
    } else {
      const vet = await vetAdaptedScript(adapted.script);
      if (!vet.ok) fail(`the adapted script failed re-vetting — ${vet.failures.join("; ")}. Nothing was sent.`);
      console.log(
        `[PresenterAdmin] adapted script re-passed the critic (clarity=${vet.scores.clarity} ` +
          `retention=${vet.scores.retention} authenticity=${vet.scores.authenticity})`
      );
    }
  }

  if (DRY_RUN) {
    console.log(`[PresenterAdmin] DRY RUN — would deliver the superseding kit to ${presenter.email}, ` +
      `notify ${previous?.id || "the owner"}, and record the reassignment. Nothing written, nothing sent.`);
    return;
  }

  // 3. Deliver the superseding kit to the NEW presenter. Sends happen before
  //    state writes: a failed send leaves nothing recorded, and the retry is
  //    re-running this dispatch.
  const accessToken = await getAccessToken().catch(() => null);
  if (accessToken) await ensureRecordingsFolder(requestId, accessToken);
  await deliverKit({
    requestId,
    script: adapted.script,
    presenter,
    accessToken,
    supersedes: previous || { id: "peter", name: "Peter" },
  });

  // 4. Tell the OLD presenter their kit is dead (best-effort, never silent).
  if (previous) {
    const oldPresenter = resolvePresenter(reg, previous.id);
    if (oldPresenter.ok) {
      await sendSupersessionNotice({
        oldPresenter: oldPresenter.presenter,
        newPresenter: presenter,
        title: record.actedResult.selectedTitle || record.actedResult.script.title,
        requestId,
        accessToken,
      });
    }
  }

  // 5. Record it: the stamp, and the adapted script into actedResult so the
  //    build matches recordings against the words the NEW presenter reads.
  let log = stamped.log;
  const updated = updateActedScript(log, requestId, adapted.script);
  if (!updated.ok) throw new Error(`kit delivered but the adapted script was not recorded: ${updated.reason}`);
  savePresenters(reg);
  saveApprovals(updated.log);
  console.log(
    `[PresenterAdmin] ✓ ${requestId} reassigned to ${presenter.id} — superseding kit delivered, ` +
      `old kit declared dead, adapted script recorded for the build`
  );
}

main().catch((err) => {
  console.error(`[PresenterAdmin] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
