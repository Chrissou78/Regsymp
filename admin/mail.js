import { Resend } from "resend";
import { env, escapeHtml, normaliseFrom } from "../api/_lib/send-invitation.js";

/**
 * Transactional email: claim links, password resets.
 *
 * Separate from the invitation form's sender because these are different in
 * kind — one is a stranger asking to be let in, these go to people who
 * already have an account. Same credentials, same verified domain.
 *
 * `sendImpl` is injectable so tests never send anything.
 */

/** Wrap body copy in something that looks like the site rather than a form. */
export function template({ heading, lines, action = null }) {
  const paragraphs = lines.map((l) => `<p style="margin:0 0 16px">${escapeHtml(l)}</p>`).join("");
  const button = action
    ? `<p style="margin:28px 0">
         <a href="${escapeHtml(action.href)}"
            style="background:#1C2B4A;color:#fff;text-decoration:none;padding:13px 22px;
                   border-radius:3px;font-weight:600;display:inline-block">${escapeHtml(action.label)}</a>
       </p>
       <p style="margin:0 0 16px;color:#6B6E7A;font-size:13px">
         If the button does not work, paste this into your browser:<br>
         <span style="word-break:break-all">${escapeHtml(action.href)}</span>
       </p>`
    : "";

  return `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;
                      color:#2C2E3A;max-width:560px;margin:0 auto;padding:32px 24px">
    <p style="font-family:Georgia,serif;font-size:22px;letter-spacing:0.08em;
              margin:0 0 28px;color:#1C2B4A">REGSYMP</p>
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:400;margin:0 0 20px">
      ${escapeHtml(heading)}</h1>
    ${paragraphs}
    ${button}
    <hr style="border:none;border-top:1px solid #D8D3C8;margin:32px 0 16px">
    <p style="margin:0;color:#6B6E7A;font-size:12px">
      RegSymp · Palma de Mallorca · 14–15 September 2026</p>
  </div>`;
}

export function createMailer({ sendImpl = null } = {}) {
  const configured = () => Boolean(env("RESEND_API_KEY") && normaliseFrom(env("RESEND_FROM")));

  async function send({ to, subject, html, text }) {
    if (!configured()) {
      throw new Error("Email is not configured: RESEND_API_KEY or RESEND_FROM is missing.");
    }

    const payload = {
      from: normaliseFrom(env("RESEND_FROM")),
      to,
      subject,
      html,
      ...(text ? { text } : {})
    };

    if (sendImpl) return sendImpl(payload);

    const resend = new Resend(env("RESEND_API_KEY"));
    const { error } = await resend.emails.send(payload);
    // Resend reports failures in the body rather than by throwing, so an
    // unchecked call looks like a success and the person never gets the link.
    if (error) throw new Error(error.message ?? "Resend rejected the message.");
    return { ok: true };
  }

  return {
    configured,
    send,

    /** The link that turns an invitation into an account. */
    sendClaimLink({ to, url, name = null }) {
      return send({
        to,
        subject: "Your RegSymp account",
        html: template({
          heading: "Set your password",
          lines: [
            name ? `${name},` : "Hello,",
            "You have been registered for RegSymp Palma de Mallorca. Setting a password gives you access to your profile and your ticket.",
            "This link is valid for 30 days and can be used once."
          ],
          action: { href: url, label: "Set your password" }
        }),
        text: `Set your password for RegSymp: ${url}\n\nValid for 30 days, single use.`
      });
    },

    /** Proves the address belongs to whoever typed it. */
    sendVerificationLink({ to, url }) {
      return send({
        to,
        subject: "Confirm your email for RegSymp",
        html: template({
          heading: "Confirm your email",
          lines: [
            "Hello,",
            "Please confirm this address so it can be used for your RegSymp account. Creating an account is not itself a registration for the event — the organisers issue tickets separately, and cannot issue one to an unconfirmed address.",
            "This link is valid for seven days."
          ],
          action: { href: url, label: "Confirm my email" }
        }),
        text: `Confirm your email for RegSymp: ${url}

Valid for seven days.`
      });
    },

    sendResetLink({ to, url }) {
      return send({
        to,
        subject: "Choose a new RegSymp password",
        html: template({
          heading: "Choose a new password",
          lines: [
            "Hello,",
            "Somebody asked to reset the password for this address. If that was not you, you can ignore this message and nothing will change.",
            "This link is valid for one hour and can be used once."
          ],
          action: { href: url, label: "Choose a new password" }
        }),
        text: `Choose a new RegSymp password: ${url}\n\nValid for one hour, single use.`
      });
    }
  };
}
