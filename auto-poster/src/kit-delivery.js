/**
 * kit-delivery.js — one place that knows how a recording kit reaches a
 * presenter.
 *
 * Three callers need identical behaviour — the scheduled pipeline (fresh
 * approval), the assign-presenter dispatch (reassignment after delivery), and
 * resend-kit — and before this module each would have grown its own copy of
 * "who gets which email". The rules, stated once:
 *
 *   THE PRESENTER gets the onboarding email: what this is, the recorder link,
 *   THEIR access code, the drill, then the full kit. This is the email the
 *   whole system is named for, so for a guest it failing is FATAL — a kit
 *   that reached nobody must not mark the stage advanced.
 *
 *   PETER always gets the dashboard card and an owner email. For his own
 *   kits that email IS the kit (with his code — the recorder gate applies to
 *   him too). For a guest's kit it is the kit prefixed with who it went to,
 *   and WITHOUT the guest's access code: a code is for exactly one inbox.
 *
 *   TEST- presenters and TEST- requests exercise all of this with mail
 *   suppressed (sendPresenterEmail prints instead) and the card marked the
 *   way every smoke artifact is marked.
 */

import { buildKit, renderKitText, kitPayload } from "./yt-recording-kit.js";
import { sendApprovalRequest, sendPresenterEmail } from "./delivery.js";
import { isTestPresenter, ROLE_OWNER } from "./presenters.js";
import { KIND_TOPIC_PICK, isTestRequest } from "./yt-approvals.js";
import { NARRATION_MODE } from "./yt-config.js";

/**
 * May this presenter front this request at all?
 *
 * A TEST- presenter on a REAL request would suppress the real kit mail —
 * the video would sit forever waiting on a recording nobody was asked for.
 * Inert means inert: test people touch test requests only.
 */
export function assertAssignable(presenter, requestId) {
  if (isTestPresenter(presenter) && !isTestRequest(requestId)) {
    return {
      ok: false,
      reason:
        `"${presenter.id}" is a TEST- presenter and ${requestId} is a real request — ` +
        `a test presenter's mail is suppressed, so the real kit would silently reach nobody. ` +
        `Assign a real presenter, or test against a TEST- request.`,
    };
  }
  return { ok: true };
}

/**
 * Build the kit for a script and deliver it to its presenter.
 *
 * Returns { kit, channels } on success. Throws when the kit reached nobody
 * who can record it — the caller's retry (the scheduled run, or a re-dispatch)
 * is the recovery, exactly as sendApprovalRequest already behaves.
 */
export async function deliverKit({
  requestId,
  script,
  presenter,
  accessToken,
  narrationMode = NARRATION_MODE,
  // A reassignment names what it replaces so the card and both emails say it
  // out loud — "superseded loudly, never two live kits".
  supersedes = null,
  dryRun = false,
}) {
  const kit = buildKit({ script, title: script.title }, { requestId, narrationMode });
  const isOwner = presenter.role === ROLE_OWNER;

  const supersedeLines = supersedes
    ? [
        `*** THIS KIT SUPERSEDES THE ONE SENT TO ${String(supersedes.name || supersedes.id || "the previous presenter").toUpperCase()} ` +
          `ON ${supersedes.assignedAt || "an earlier date"}. That kit is dead — only recordings of THIS kit are used. ***`,
        "",
      ]
    : [];

  // The presenter's copy: onboarding + code + kit.
  const presenterBody = [
    ...supersedeLines,
    renderKitText(kit, { presenter, accessCode: presenter.accessCode }),
  ].join("\n");

  // Peter's copy: for his own kit it is the same email; for a guest's it
  // names the recipient and carries no code.
  const ownerBody = isOwner
    ? presenterBody
    : [
        `KIT DELIVERED TO: ${presenter.name} <${presenter.email}>`,
        `Their access code went to their inbox, not this one.`,
        "",
        ...supersedeLines,
        renderKitText(kit),
      ].join("\n");

  const subject = `Recording kit — ${kit.title} (${kit.stats.takeCount} takes${isOwner ? "" : `, presenter: ${presenter.name}`})`;

  if (dryRun) {
    console.log(`[KitDelivery] DRY RUN — would deliver ${requestId} to ${presenter.id} (${presenter.email})`);
    console.log(presenterBody);
    return { kit, channels: [], dryRun: true };
  }

  const channels = [];

  // The presenter's email goes FIRST: it is the one delivery that cannot be
  // substituted, and if it fails nothing should be marked sent. A retry that
  // re-raises the dashboard card costs a duplicate notification; a kit whose
  // presenter never heard about it costs the whole cycle.
  if (!isOwner) {
    const sent = await sendPresenterEmail(accessToken, { presenter, subject, body: presenterBody });
    if (!sent.ok) {
      throw new Error(
        `the kit for ${requestId} did not reach its presenter (${presenter.email}): ${sent.lastError?.message || "unknown"}. ` +
          `Nothing is marked delivered; the next run retries.`
      );
    }
    channels.push(sent.suppressed ? "presenter-email(suppressed:test)" : "presenter-email");
  }

  // The dashboard card + Peter's email, over the existing two-channel path.
  await sendApprovalRequest({
    requestId,
    kind: KIND_TOPIC_PICK,
    payload: {
      stage: "recording_kit",
      ...kitPayload(kit, { presenter }),
      ...(supersedes ? { supersedes: { id: supersedes.id || null, name: supersedes.name || null } } : {}),
    },
    emailSubject: subject,
    emailBody: ownerBody,
    accessToken,
  });
  channels.push("dashboard+owner");

  return { kit, channels };
}

/**
 * Tell a superseded presenter their kit is dead. Best-effort by design — the
 * new kit going out does not depend on the old one's goodbye arriving — but
 * never silent: a failure is logged as a warning with the address.
 */
export async function sendSupersessionNotice({ oldPresenter, newPresenter, title, requestId, accessToken }) {
  if (!oldPresenter || oldPresenter.role === ROLE_OWNER) return { ok: true, skipped: "owner sees the card" };
  const body = [
    `Hi ${String(oldPresenter.name || "").split(/\s+/)[0] || "there"},`,
    "",
    `The video "${title}" has been reassigned to ${newPresenter.name}, so the recording kit you were sent for it is no longer live.`,
    `Please don't record those takes — anything recorded from the old kit won't be used.`,
    "",
    `Nothing else changes for you. If you think this is a mistake, reply to this email.`,
  ].join("\n");
  const sent = await sendPresenterEmail(accessToken, {
    presenter: oldPresenter,
    subject: `Kit superseded — ${title}`,
    body,
  });
  if (!sent.ok) {
    console.log(
      `::warning::[KitDelivery] could not tell ${oldPresenter.email} their kit for ${requestId} is superseded — ` +
        `${sent.lastError?.message || "unknown"}. Tell them another way.`
    );
  }
  return sent;
}
