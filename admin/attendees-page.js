import { escape, layout } from "./render.js";

/**
 * The guest list.
 *
 * Registration is open to anyone, so this is where admission is actually
 * decided: an account appears here the moment somebody signs up, and stays
 * ticketless until an admin issues one. That is the whitelist.
 *
 * Kept in its own module because admin/routes.js is already long, and this
 * page has nothing to do with editing site content.
 */

const TIER_LABEL = { vip: "VIP", general: "Delegate" };

function stateOf(guest) {
  if (!guest.claimed) return { label: "invited", hint: "has not set a password yet" };
  if (guest.selfRegistered && !guest.emailVerified) {
    return { label: "unconfirmed", hint: "registered but has not confirmed their email" };
  }
  return { label: "active", hint: "" };
}

function row({ guest, token, speakerSlugs }) {
  const state = stateOf(guest);
  const canTicket = !guest.selfRegistered || guest.emailVerified;

  const hidden = `<input type="hidden" name="csrf" value="${escape(token)}">
    <input type="hidden" name="id" value="${guest.id}">`;

  return `<li class="a-row a-row--stack">
    <div class="a-row-head">
      <span class="a-row-name">
        ${escape(guest.name ?? guest.email)}
        ${guest.role === "speaker" ? '<span class="a-count">speaker</span>' : ""}
        <span class="a-count a-state a-state--${escape(state.label)}">${escape(state.label)}</span>
      </span>
      <span class="a-count">${
        guest.ticket
          ? `${escape(TIER_LABEL[guest.ticket.tier])} #${guest.ticket.number}`
          : "no ticket"
      }</span>
    </div>

    <p class="a-note">
      ${escape(guest.email)}${guest.company ? ` &middot; ${escape(guest.company)}` : ""}
      ${state.hint ? ` &middot; ${escape(state.hint)}` : ""}
      ${guest.selfRegistered ? " &middot; self-registered" : " &middot; added by an admin"}
    </p>

    <div class="a-rowactions">
      ${
        guest.ticket
          ? `<form method="post" action="/admin/attendees" class="a-inline"
                   onsubmit="return confirm('Withdraw ticket #${guest.ticket.number}?')">
               ${hidden}<input type="hidden" name="action" value="revoke">
               <button class="a-danger">Withdraw ticket</button>
             </form>`
          : canTicket
            ? `<form method="post" action="/admin/attendees" class="a-inline">
                 ${hidden}<input type="hidden" name="action" value="issue">
                 <select name="tier" aria-label="Tier">
                   <option value="general">Delegate ticket</option>
                   <option value="vip">VIP ticket</option>
                 </select>
                 <input name="areas" placeholder="side events, comma separated"
                        aria-label="Access areas">
                 <button class="a-btn">Issue</button>
               </form>`
            : `<span class="a-note">Cannot issue a ticket until the email is confirmed.</span>`
      }

      ${
        guest.claimed
          ? ""
          : `<form method="post" action="/admin/attendees" class="a-inline">
               ${hidden}<input type="hidden" name="action" value="sendClaim">
               <button>Send set-password link</button>
             </form>`
      }
      ${
        guest.selfRegistered && !guest.emailVerified
          ? `<form method="post" action="/admin/attendees" class="a-inline">
               ${hidden}<input type="hidden" name="action" value="sendVerify">
               <button>Resend confirmation</button>
             </form>`
          : ""
      }

      ${
        guest.role === "speaker"
          ? `<form method="post" action="/admin/attendees" class="a-inline">
               ${hidden}<input type="hidden" name="action" value="linkSpeaker">
               <select name="speakerSlug" aria-label="Public speaker entry">
                 <option value="">— not linked —</option>
                 ${speakerSlugs
                   .map(
                     (s) =>
                       `<option value="${escape(s.slug)}"${
                         s.slug === guest.speakerSlug ? " selected" : ""
                       }>${escape(s.name)}</option>`
                   )
                   .join("")}
               </select>
               <button>Link</button>
             </form>`
          : ""
      }
    </div>
  </li>`;
}

export function attendeesPage({
  guests,
  capacity,
  speakerSlugs = [],
  session,
  token,
  flash = null,
  q = ""
}) {
  const rows = guests.map((guest) => row({ guest, token, speakerSlugs })).join("");

  const meters = capacity
    .map(
      (c) => `<li class="a-row">
        <span class="a-row-name">${escape(TIER_LABEL[c.tier])} &mdash; numbers ${c.from}&ndash;${c.to}</span>
        <span class="a-count">${c.issued} of ${c.limit} issued${
          c.issued >= c.limit ? " &middot; full" : ""
        }</span>
      </li>`
    )
    .join("");

  return layout({
    title: "Guest list",
    user: session.user,
    flash,
    body: `<h1>Guest list</h1>
      <p class="a-lede">Anyone can create an account; a ticket is issued here.
      Numbers are allocated in one sequence across the event, so no number is
      ever used twice.</p>

      <ul class="a-list">${meters}</ul>

      <form method="get" action="/admin/attendees" class="a-inline a-search">
        <input name="q" value="${escape(q)}" placeholder="Search name, email or company"
               aria-label="Search">
        <button>Search</button>
        ${q ? '<a class="a-count" href="/admin/attendees">Clear</a>' : ""}
      </form>

      <h2>Add someone directly</h2>
      <p class="a-note">For speakers and guests the organisers invite. An address
      entered here counts as vouched for, so it needs no confirmation click.</p>
      <form method="post" action="/admin/attendees" class="a-form a-form--inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="create">
        <input name="email" type="email" required placeholder="Email" aria-label="Email">
        <input name="firstName" placeholder="First name" aria-label="First name">
        <input name="lastName" placeholder="Surname" aria-label="Surname">
        <input name="company" placeholder="Company" aria-label="Company">
        <select name="role" aria-label="Role">
          <option value="visitor">Visitor</option>
          <option value="speaker">Speaker</option>
        </select>
        <label class="a-check">
          <input type="checkbox" name="sendClaim" value="yes" checked>
          <span>Email them a link to set a password</span>
        </label>
        <button class="a-btn">Add</button>
      </form>

      <h2>${guests.length} account${guests.length === 1 ? "" : "s"}</h2>
      ${rows ? `<ul class="a-list">${rows}</ul>` : '<p class="a-note">Nobody yet.</p>'}

      <p><a class="a-btn" href="/admin">Back to collections</a></p>`
  });
}
