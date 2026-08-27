import { Resend } from "resend";
import { validateSubmission } from "./validate.js";

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
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.error("invitation not sent, missing env: " + missing.join(", "));
    return {
      status: 502,
      body: { error: "We could not send that. Please email info@regsymp.com." }
    };
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM,
      to: process.env.INVITATION_RECIPIENT,
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
