/**
 * Pages for the attendee portal.
 *
 * Rendered here rather than by Eleventy because every one of them is
 * per-person: there is no static page to build. They pull in the site's own
 * stylesheet so the portal inherits its typography and palette instead of
 * looking like a different product bolted on.
 */

export function escape(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function layout({ title, body, guest = null, flash = null, wide = false, token = "" }) {
  const notice = flash
    ? `<div class="p-flash p-flash--${escape(flash.kind)}">${escape(flash.message)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — RegSymp</title>
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Inter:wght@400;500;600&family=Playfair+Display:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/css/styles.css">
<link rel="stylesheet" href="/assets/css/portal.css">
</head>
<body class="p-body">
<header class="p-header">
  <a class="p-wordmark" href="/">RegSymp</a>
  ${
    guest
      ? `<nav class="p-nav">
           <a href="/portal">Profile</a>
           <a href="/portal/ticket">Ticket</a>
           <form method="post" action="/portal/signout" class="p-inline">
             <input type="hidden" name="csrf" value="${escape(token)}">
             <button class="p-linkbutton">Sign out</button>
           </form>
         </nav>`
      : ""
  }
</header>

<main class="p-main${wide ? " p-main--wide" : ""}">
  ${notice}
  ${body}
</main>

<footer class="p-footer">
  <p>Palma de Mallorca · 14–15 September 2026 · Chatham House Rule</p>
</footer>
</body>
</html>`;
}

/** A labelled input. */
function field({ name, label, type = "text", value = "", help = "", attrs = "" }) {
  return `<div class="p-field">
    <label for="f-${escape(name)}">${escape(label)}</label>
    <input id="f-${escape(name)}" name="${escape(name)}" type="${escape(type)}"
           value="${escape(value)}" ${attrs}>
    ${help ? `<span class="p-help">${escape(help)}</span>` : ""}
  </div>`;
}

export function signinPage({ error = null, email = "" } = {}) {
  return layout({
    title: "Sign in",
    flash: error ? { kind: "error", message: error } : null,
    body: `<div class="p-card p-card--narrow">
      <h1>Your RegSymp account</h1>
      <p class="p-lede">Sign in to see your profile and your ticket.</p>
      <form method="post" action="/portal/signin" class="p-form">
        ${field({ name: "email", label: "Email", type: "email", value: email, attrs: 'required autocomplete="username" autofocus' })}
        ${field({ name: "password", label: "Password", type: "password", attrs: 'required autocomplete="current-password"' })}
        <div class="p-actions">
          <button class="p-btn" type="submit">Sign in</button>
          <a class="p-quiet" href="/portal/forgot">Forgotten your password?</a>
        </div>
      </form>
      <p class="p-note">Attendance is by invitation. If you have not received a link
      to set your password, please contact the organisers.</p>
    </div>`
  });
}

export function setPasswordPage({ token, purpose, email, error = null }) {
  const claiming = purpose === "claim";
  return layout({
    title: claiming ? "Set your password" : "Choose a new password",
    flash: error ? { kind: "error", message: error } : null,
    body: `<div class="p-card p-card--narrow">
      <h1>${claiming ? "Set your password" : "Choose a new password"}</h1>
      <p class="p-lede">${
        claiming
          ? `Welcome. This sets the password for <strong>${escape(email)}</strong>.`
          : `For <strong>${escape(email)}</strong>.`
      }</p>
      <form method="post" action="/portal/${claiming ? "claim" : "reset"}/${escape(token)}" class="p-form">
        ${field({ name: "password", label: "Password", type: "password", help: "At least 12 characters.", attrs: 'required minlength="12" autocomplete="new-password" autofocus' })}
        ${field({ name: "confirm", label: "Confirm password", type: "password", attrs: 'required minlength="12" autocomplete="new-password"' })}
        <div class="p-actions"><button class="p-btn" type="submit">Save and sign in</button></div>
      </form>
    </div>`
  });
}

export function forgotPage({ sent = false, error = null } = {}) {
  return layout({
    title: "Forgotten password",
    flash: error ? { kind: "error", message: error } : null,
    body: sent
      ? `<div class="p-card p-card--narrow">
           <h1>Check your email</h1>
           <p class="p-lede">If that address has an account, a link to choose a new
           password is on its way. It is valid for one hour.</p>
           <p><a class="p-quiet" href="/portal/signin">Back to sign in</a></p>
         </div>`
      : `<div class="p-card p-card--narrow">
           <h1>Forgotten your password?</h1>
           <p class="p-lede">We will email you a link to choose a new one.</p>
           <form method="post" action="/portal/forgot" class="p-form">
             ${field({ name: "email", label: "Email", type: "email", attrs: 'required autocomplete="username" autofocus' })}
             <div class="p-actions">
               <button class="p-btn" type="submit">Send the link</button>
               <a class="p-quiet" href="/portal/signin">Back to sign in</a>
             </div>
           </form>
         </div>`
  });
}

const COUNTRIES_NOTE = "Two-letter code or country name — whichever you prefer.";

export function profilePage({ guest, ticket, token, saved = false, error = null }) {
  const socials = guest.socials ?? {};
  const speaker = guest.role === "speaker";

  return layout({
    title: "Your profile",
    guest,
    token,
    flash: error
      ? { kind: "error", message: error }
      : saved
        ? { kind: "ok", message: "Your details have been saved." }
        : null,
    body: `<div class="p-card">
      <h1>Your profile</h1>
      <p class="p-lede">${escape(guest.email)}${
        speaker ? ' · <span class="p-badge">Speaker</span>' : ""
      }</p>

      ${
        ticket
          ? `<a class="p-ticketstrip" href="/portal/ticket">
               <span class="p-ticketstrip-label">${escape(ticket.tier === "vip" ? "VIP" : "Delegate")} ticket</span>
               <span class="p-ticketstrip-number">${escape(ticket.label)}</span>
               <span class="p-quiet">View and add to your phone &rarr;</span>
             </a>`
          : `<p class="p-note">No ticket has been issued to you yet. The organisers
             will assign one before the event.</p>`
      }

      <form method="post" action="/portal" class="p-form p-form--grid">
        <input type="hidden" name="csrf" value="${escape(token)}">
        ${field({ name: "firstName", label: "First name", value: guest.firstName ?? "" })}
        ${field({ name: "lastName", label: "Surname", value: guest.lastName ?? "" })}
        ${field({ name: "company", label: "Company", value: guest.company ?? "" })}
        ${field({ name: "position", label: "Position", value: guest.position ?? "" })}
        ${field({ name: "country", label: "Country", value: guest.country ?? "", help: COUNTRIES_NOTE })}
        ${field({
          name: "birthDate",
          label: "Date of birth",
          type: "date",
          value: guest.birthDate ? new Date(guest.birthDate).toISOString().slice(0, 10) : "",
          help: "Optional. Used only for venue access requirements."
        })}
        ${field({ name: "linkedin", label: "LinkedIn", type: "url", value: socials.linkedin ?? "" })}
        ${field({ name: "x", label: "X", type: "url", value: socials.x ?? "" })}

        ${
          speaker
            ? `<div class="p-field p-field--full">
                 <label for="f-description">Speaker biography</label>
                 <textarea id="f-description" name="description" rows="6"
                           maxlength="2000">${escape(guest.description ?? "")}</textarea>
                 <span class="p-help">Shown on the public speakers page.</span>
               </div>`
            : ""
        }

        <div class="p-field p-field--full p-consent">
          <label class="p-check">
            <input type="checkbox" name="consentMarketing" value="yes"
                   ${guest.consentMarketing ? "checked" : ""}>
            <span>Send me event updates and news about future editions.</span>
          </label>
          <span class="p-help">You can change this at any time. Event-critical
          messages about your own attendance are sent regardless.</span>
        </div>

        <div class="p-actions p-field--full">
          <button class="p-btn" type="submit">Save changes</button>
          <a class="p-quiet" href="/portal/password">Change password</a>
        </div>
      </form>
    </div>`
  });
}

export function ticketPage({ guest, ticket, qr, token }) {
  const vip = ticket.tier === "vip";
  return layout({
    title: "Your ticket",
    guest,
    token,
    body: `<div class="p-ticket">
      <div class="p-ticket-head">
        <span class="p-ticket-kind${vip ? " p-ticket-kind--vip" : ""}">${vip ? "VIP" : "Delegate"}</span>
        <span class="p-ticket-number">${escape(ticket.label)}</span>
      </div>

      <div class="p-ticket-body">
        <div class="p-qr">${qr}</div>
        <dl class="p-ticket-meta">
          <dt>Name</dt><dd>${escape(guest.name ?? guest.email)}</dd>
          ${guest.company ? `<dt>Company</dt><dd>${escape(guest.company)}</dd>` : ""}
          <dt>Event</dt><dd>RegSymp Palma de Mallorca</dd>
          <dt>Dates</dt><dd>14–15 September 2026</dd>
          ${
            ticket.areas?.length
              ? `<dt>Access</dt><dd>${ticket.areas.map((a) => escape(a.replace(/^side:/, ""))).join(", ")}</dd>`
              : ""
          }
          ${ticket.checkedInAt ? `<dt>Checked in</dt><dd>${escape(new Date(ticket.checkedInAt).toISOString().slice(0, 16).replace("T", " "))}</dd>` : ""}
        </dl>
      </div>

      <p class="p-ticket-foot">Present this code at registration. It is unique to you
      and should not be shared.</p>
    </div>

    <p class="p-centre p-backlink"><a class="p-quiet" href="/portal">Back to your profile</a></p>`
  });
}

export function changePasswordPage({ guest, token, error = null, saved = false }) {
  return layout({
    title: "Change password",
    guest,
    token,
    flash: error
      ? { kind: "error", message: error }
      : saved
        ? { kind: "ok", message: "Your password has been changed." }
        : null,
    body: `<div class="p-card p-card--narrow">
      <h1>Change password</h1>
      <form method="post" action="/portal/password" class="p-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        ${field({ name: "current", label: "Current password", type: "password", attrs: 'required autocomplete="current-password"' })}
        ${field({ name: "password", label: "New password", type: "password", help: "At least 12 characters.", attrs: 'required minlength="12" autocomplete="new-password"' })}
        ${field({ name: "confirm", label: "Confirm new password", type: "password", attrs: 'required minlength="12" autocomplete="new-password"' })}
        <div class="p-actions">
          <button class="p-btn" type="submit">Change password</button>
          <a class="p-quiet" href="/portal">Cancel</a>
        </div>
      </form>
    </div>`
  });
}
