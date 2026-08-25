import { Resend } from "resend";
import { validateSubmission } from "./_lib/validate.js";

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const result = validateSubmission(body);
  if (!result.ok) return res.status(400).json({ error: result.error });

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
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("invitation send failed:", err);
    return res
      .status(502)
      .json({ error: "We could not send that. Please email info@regsymp.com." });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
