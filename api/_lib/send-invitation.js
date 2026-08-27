import { Resend } from "resend";
import { validateSubmission } from "./validate.js";

/**
 * Whether the mail config is present — never what it contains.
 * Lets us tell "variables missing" apart from "Resend rejected it"
 * without reading server logs or exposing the key.
 */
export function configStatus() {
  const from = normaliseFrom(env("RESEND_FROM"));
  return {
    config: {
      RESEND_API_KEY: Boolean(env("RESEND_API_KEY")),
      RESEND_FROM: Boolean(from),
      INVITATION_RECIPIENT: Boolean(env("INVITATION_RECIPIENT"))
    },
    // domain only; the local part and the key are never exposed
    fromDomain: from.includes("@") ? from.split("@").pop().replace(/>$/, "").trim() : null,
    // RESEND_FROM is not a secret — it appears in the From header of every
    // message sent. Exposing it verbatim makes stray quotes or whitespace
    // obvious without needing shell access to the box.
    fromRaw: process.env.RESEND_FROM ?? null,
    fromResolved: from || null,
    fromLooksValid: /^[^<>]*<[^<>@\s]+@[^<>@\s]+>$|^[^<>@\s]+@[^<>@\s]+$/.test(from),
    normalisesFrom: true
  };
}

/**
 * Normalise an email From value.
 *
 * A From header is either `local@domain` or `Display Name <local@domain>`.
 * Nothing may follow the closing angle bracket, so anything after it is
 * config damage — we saw a lone trailing quote survive a deploy and get
 * rejected by Resend. Truncating there is unambiguous rather than a guess,
 * unlike stripping arbitrary stray characters.
 */
export function normaliseFrom(value) {
  // Strip a matched pair wrapping the whole value first, so this is correct
  // whether or not env() has already run. A quoted display name such as
  // `"RegSymp, Ltd" <a@b.com>` does not end in a quote, so it is untouched.
  const trimmed = String(value ?? "")
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();

  const close = trimmed.lastIndexOf(">");
  if (close !== -1 && trimmed.includes("<")) return trimmed.slice(0, close + 1).trim();
  return trimmed;
}

/**
 * Read an env var, stripping wrapping quotes.
 *
 * Docker's --env-file and some systemd unit styles keep quote characters as
 * part of the value, which produced a From header of
 * "RegSymp <noreply@...>" — quotes included — that Resend rejected.
 */
export function env(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return "";
  // Only strip when the quotes match and wrap the whole value.
  return raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/**
 * Validate a submission and email it on.
 *
 * Transport-agnostic on purpose: the Vercel function and the standalone
 * Node server both call this, so there is one implementation to test and
 * one place a change has to be made.
 *
 * Returns { status, body } ready to serialise as JSON.
 */
export async function handleInvitation(body) {
  const result = validateSubmission(body);
  if (!result.ok) return { status: 400, body: { error: result.error } };

  const { name, email, company, role, mobile, message } = result.data;

  const rows = [
    ["Name", name],
    ["Email", email],
    ["Company", company],
    ["Role", role],
    ["Mobile", mobile || "—"],
    ["Message", message || "—"]
  ];

  const html =
    "<h2>Invitation request</h2><table cellpadding='6' style='border-collapse:collapse'>" +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="vertical-align:top"><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`
      )
      .join("") +
    "</table>";

  const missing = ["RESEND_API_KEY", "RESEND_FROM", "INVITATION_RECIPIENT"].filter(
    (k) => !env(k)
  );
  if (missing.length) {
    console.error("invitation not sent, missing env: " + missing.join(", "));
    return {
      status: 502,
      body: { error: "We could not send that. Please email info@regsymp.com." }
    };
  }

  try {
    const resend = new Resend(env("RESEND_API_KEY"));
    const { error } = await resend.emails.send({
      from: normaliseFrom(env("RESEND_FROM")),
      to: env("INVITATION_RECIPIENT"),
      replyTo: email,
      subject: `Invitation request — ${name}, ${company}`,
      html
    });
    if (error) throw new Error(error.message || "send failed");
    return { status: 200, body: { ok: true } };
  } catch (err) {
    console.error("invitation send failed:", err);
    return {
      status: 502,
      body: { error: "We could not send that. Please email info@regsymp.com." }
    };
  }
}
