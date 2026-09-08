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

function stateOf(guest) {
  if (!guest.claimed) return { label: "invited", hint: "has not set a password yet" };
  if (guest.selfRegistered && !guest.emailVerified) {
    return { label: "unconfirmed", hint: "registered but has not confirmed their email" };
  }
  return { label: "active", hint: "" };
}

/**
 * The badge categories somebody can be given, as they stand right now.
 *
 * Built from the categories table rather than hardcoded, so a category the
 * organisers add at /admin/categories appears here without a code change.
 * This list was hardcoded to "general" and "vip" and posted a field called
 * tier, which 008 dropped: whatever was chosen, the route read no category at
 * all and every attempt to issue a badge failed.
 *
 * No default for a visitor -- the first category would be chosen for them,
 * which is not the same as choosing. A speaker is the exception, being the one
 * case where the right answer is known.
 */
function categoryOptions(categories, guest) {
  const preselect = guest.role === "speaker" ? "speaker" : null;

  const options = categories.map((c) => {
    const full = c.numbered && c.issued >= c.limit;
    const left = c.numbered ? ` — ${c.limit - c.issued} left` : "";
    return `<option value="${escape(c.slug)}"${full ? " disabled" : ""}${
      !full && c.slug === preselect ? " selected" : ""
    }>${escape(c.label)}${full ? " — full" : left}</option>`;
  });

  const placeholder = `<option value=""${preselect ? "" : " selected"} disabled>Badge type…</option>`;
  return placeholder + options.join("");
}

function row({ guest, token, speakerSlugs, categories }) {
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
          ? `<span class="a-badgedot" style="background:${escape(guest.ticket.colour)}"></span>${escape(
              guest.ticket.label
            )}${guest.ticket.number ? ` #${guest.ticket.number}` : ""}${
              guest.ticket.claimedAt
                ? ' <span class="a-state a-state--claimed">claimed</span>'
                : ' <span class="a-state a-state--unclaimed">not claimed</span>'
            }`
          : "no badge"
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
          ? `<a class="a-count" href="/admin/badges/${escape(guest.ticket.code)}" target="_blank"
                 rel="noopener">Print badge</a>
             <form method="post" action="/admin/attendees" class="a-inline"
                   onsubmit="return confirm('Withdraw this badge? Its number stays out of circulation.')">
               ${hidden}<input type="hidden" name="action" value="revoke">
               <button class="a-danger">Withdraw badge</button>
             </form>
             ${
               guest.ticket.number === null || guest.ticket.claimedAt
                 ? ""
                 : `<form method="post" action="/admin/attendees" class="a-inline"
                          onsubmit="return confirm('Cancel this badge and free number ${
                            guest.ticket.number
                          } for someone else?')">
                      ${hidden}<input type="hidden" name="action" value="revoke">
                      <input type="hidden" name="release" value="yes">
                      <button class="a-danger">Cancel &amp; free #${guest.ticket.number}</button>
                    </form>`
             }
             ${
               guest.ticket.claimedAt
                 ? `<span class="a-note">Claimed, so it is fixed: the number cannot be
                    reused. Withdrawing rescinds the place and retires the number
                    with it.</span>`
                 : ""
             }`
          : canTicket
            ? `<form method="post" action="/admin/attendees" class="a-inline">
                 ${hidden}<input type="hidden" name="action" value="issue">
                 <select name="category" aria-label="Badge category" required>
                   ${categoryOptions(categories, guest)}
                 </select>
                 <input name="number" placeholder="no." aria-label="Badge number"
                        inputmode="numeric" size="4" class="a-num">
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
  categories = [],
  speakerSlugs = [],
  session,
  token,
  flash = null,
  q = ""
}) {
  const rows = guests.map((guest) => row({ guest, token, speakerSlugs, categories })).join("");

  const meters = capacity
    .map(
      (c) => `<li class="a-row">
        <span class="a-row-name">
          <span class="a-badgedot" style="background:${escape(c.colour)}"></span>
          ${escape(c.label)}${
            c.numbered ? ` &mdash; numbers ${c.from}&ndash;${c.to}` : " &mdash; unnumbered"
          }</span>
        <span class="a-count">${
          c.numbered
            ? `${c.issued} of ${c.limit} issued${c.issued >= c.limit ? " &middot; full" : ""}`
            : `${c.issued} issued`
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
      <p class="a-note"><a href="/admin/badges">Print badges</a> &nbsp;·&nbsp;
      <a href="/admin/categories">Manage badge categories</a></p>
      <p class="a-note">A badge is attributed here and then claimed by the guest
      in their own profile. Until they claim it you can <strong>cancel it and
      free the number</strong> for somebody else; once claimed it is fixed,
      because they are holding it. Leave the number box empty to take the next
      free number, or type one in to hand out a particular one — a number freed
      by a cancellation, for instance.</p>

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

      <h2>Add several at once</h2>
      <p class="a-note">Paste a CSV, a block copied from a spreadsheet, or just a
      column of addresses. A header row is used if there is one; without one the
      address is found wherever it sits. You will see what was understood before
      anything is created.</p>
      <form method="post" action="/admin/attendees" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="importPreview">
        <textarea name="paste" rows="6" class="a-paste" aria-label="Pasted guest list"
                  placeholder="Email,First name,Surname,Company&#10;ada@example.com,Ada,Lovelace,Engines"></textarea>
        <div class="a-form--inline">
          <select name="role" aria-label="Role for everyone in this paste">
            <option value="visitor">All as visitors</option>
            <option value="speaker">All as speakers</option>
          </select>
          <label class="a-check">
            <input type="checkbox" name="sendClaim" value="yes">
            <span>Email each of them a link to set a password</span>
          </label>
          <button class="a-btn">Read the list</button>
        </div>
      </form>

      <h2>${guests.length} account${guests.length === 1 ? "" : "s"}</h2>
      ${rows ? `<ul class="a-list">${rows}</ul>` : '<p class="a-note">Nobody yet.</p>'}

      <p><a class="a-btn" href="/admin">Back to collections</a></p>`
  });
}

/**
 * What the paste was understood to mean, before anything is created.
 *
 * A preview rather than a straight import because the failure that matters is
 * not a rejected row -- it is a hundred rows accepted with the columns one
 * place out, which reads perfectly well in a success message.
 */
export function importPreviewPage({ parsed, existing, role, sendClaim, paste, session, token }) {
  const known = new Set(existing.map((g) => g.email));
  const fresh = parsed.rows.filter((r) => !known.has(r.email));
  const already = parsed.rows.filter((r) => known.has(r.email));

  const cell = (v) => `<td>${v ? escape(v) : '<span class="a-count">—</span>'}</td>`;

  const table = (rows) => `<div class="a-tablewrap"><table class="a-table">
    <thead><tr><th>Email</th><th>First name</th><th>Surname</th><th>Company</th><th>Position</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>${cell(r.email)}${cell(r.firstName)}${cell(r.lastName)}${cell(r.company)}${cell(
          r.position
        )}</tr>`
      )
      .join("")}</tbody></table></div>`;

  return layout({
    title: "Check the list",
    user: session.user,
    body: `<h1>Check the list</h1>
      <p class="a-lede">Read as ${
        parsed.hadHeader ? "a table with a header row" : "rows without a header"
      }${
        parsed.delimiter
          ? `, separated by ${
              { "	": "tabs", ",": "commas", ";": "semicolons" }[parsed.delimiter] ?? "a delimiter"
            }`
          : ", one field per line"
      }. Nothing has been created yet.</p>

      <ul class="a-list">
        <li class="a-row"><span class="a-row-name">To add</span><span class="a-count">${fresh.length}</span></li>
        <li class="a-row"><span class="a-row-name">Already have an account</span><span class="a-count">${already.length}</span></li>
        <li class="a-row"><span class="a-row-name">Could not be read</span><span class="a-count">${parsed.problems.length}</span></li>
      </ul>

      ${
        fresh.length
          ? `<h2>Will be added as ${escape(role === "speaker" ? "speakers" : "visitors")}</h2>
             <p class="a-note">Check the columns line up before confirming. If a surname
             has landed under Company, the paste needs a header row.</p>
             ${table(fresh)}`
          : '<p class="a-note">Nothing new to add.</p>'
      }

      ${already.length ? `<h2>Skipped &mdash; already registered</h2>${table(already)}` : ""}

      ${
        parsed.problems.length
          ? `<h2>Could not be read</h2>
             <p class="a-note">These lines are listed rather than dropped, so nobody
             goes missing without anybody noticing.</p>
             <ul class="a-list">${parsed.problems
               .map(
                 (p) => `<li class="a-row">
                     <span class="a-row-name"><code>${escape(p.text.slice(0, 90))}</code></span>
                     <span class="a-count">line ${p.line} &middot; ${escape(p.reason)}</span>
                   </li>`
               )
               .join("")}</ul>`
          : ""
      }

      <form method="post" action="/admin/attendees" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="importConfirm">
        <input type="hidden" name="role" value="${escape(role)}">
        ${sendClaim ? '<input type="hidden" name="sendClaim" value="yes">' : ""}
        <textarea name="paste" hidden>${escape(paste)}</textarea>
        <div class="a-form--inline">
          ${
            fresh.length
              ? `<button class="a-btn">Add ${fresh.length} ${
                  fresh.length === 1 ? "person" : "people"
                }${sendClaim ? " and email them" : ""}</button>`
              : ""
          }
          <a class="a-count" href="/admin/attendees">Back without adding</a>
        </div>
      </form>`
  });
}
