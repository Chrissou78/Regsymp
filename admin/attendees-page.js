import { escape, layout } from "./render.js";

/**
 * The guest list.
 *
 * Registration is open to anyone, so this is where admission is decided: an
 * account appears the moment somebody signs up, and carries no badge until an
 * admin puts them in a category. That is the whitelist.
 *
 * An account's category *is* its badge category, so adding somebody here
 * attributes their badge at the same time -- there is nothing left to choose
 * afterwards, and a numbered category takes the next number in its range. The
 * guest then claims it in their own profile, and from that moment it is fixed.
 *
 * Grouped by category rather than listed flat: the list is read as "who are
 * the speakers", not "who signed up on Tuesday".
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

/** Every category, as options, for choosing what somebody is. */
function categoryOptions(categories, { selected = null, plural = false } = {}) {
  return categories
    .map((c) => {
      const full = c.numbered && c.issued >= c.limit;
      const left = c.numbered ? ` (${Math.max(0, c.limit - c.issued)} left)` : "";
      const label = plural ? `All as ${c.label}` : c.label;
      return `<option value="${escape(c.slug)}"${full ? " disabled" : ""}${
        !full && c.slug === selected ? " selected" : ""
      }>${escape(label)}${full ? " — full" : left}</option>`;
    })
    .join("");
}

/**
 * What can still be done about one person's badge.
 *
 * Three states, and only one of them is a button. A claimed badge is in
 * somebody's hands, so there is nothing to press: the row says so and stops
 * there.
 */
function badgeCell({ guest, hidden }) {
  if (!guest.ticket) {
    return `<div class="a-badgecell">
      <span class="a-count">no badge</span>
      <form method="post" action="/admin/attendees" class="a-inline">
        ${hidden}<input type="hidden" name="action" value="issue">
        <button>Attribute ${escape(guest.categoryLabel ?? guest.category)} badge</button>
      </form>
    </div>`;
  }

  // The number is what the row is scanned for, so it is what the row shows.
  // An unnumbered badge names its category instead, having nothing else to say.
  const badge = `<span class="a-badgeis">
    <span class="a-badgedot" style="background:${escape(guest.ticket.colour)}"></span>
    ${
      guest.ticket.number === null
        ? escape(guest.ticket.label)
        : `${escape(guest.ticket.label)} <strong>#${guest.ticket.number}</strong>`
    }
  </span>`;

  if (guest.ticket.claimedAt) {
    return `<div class="a-badgecell">
      ${badge}
      <span class="a-state a-state--claimed">claimed</span>
    </div>`;
  }

  const warning =
    guest.ticket.number === null
      ? "Cancel this badge?"
      : `Cancel this badge? Number ${guest.ticket.number} goes back to the next person.`;

  return `<div class="a-badgecell">
    ${badge}
    <span class="a-state a-state--unclaimed">not claimed</span>
    <form method="post" action="/admin/attendees" class="a-inline"
          onsubmit="return confirm(&quot;${escape(warning)}&quot;)">
      ${hidden}<input type="hidden" name="action" value="revoke">
      <input type="hidden" name="release" value="yes">
      <button class="a-danger">Cancel</button>
    </form>
  </div>`;
}

function row({ guest, token, speakerSlugs }) {
  const state = stateOf(guest);
  const hidden = `<input type="hidden" name="csrf" value="${escape(token)}">
    <input type="hidden" name="id" value="${guest.id}">`;

  const extras = [
    guest.ticket
      ? `<a class="a-count" href="/admin/badges/${escape(guest.ticket.code)}" target="_blank"
            rel="noopener">Print</a>`
      : "",
    guest.claimed || !guest.email
      ? ""
      : `<form method="post" action="/admin/attendees" class="a-inline">
           ${hidden}<input type="hidden" name="action" value="sendClaim">
           <button>Send set-password link</button>
         </form>`,
    guest.selfRegistered && !guest.emailVerified
      ? `<form method="post" action="/admin/attendees" class="a-inline">
           ${hidden}<input type="hidden" name="action" value="sendVerify">
           <button>Resend confirmation</button>
         </form>`
      : "",
    guest.email
      ? ""
      : `<form method="post" action="/admin/attendees" class="a-inline">
           ${hidden}<input type="hidden" name="action" value="setEmail">
           <input name="email" type="email" placeholder="their email" aria-label="Email"
                  required size="22">
           <button>Add address</button>
         </form>`,
    guest.category === "speaker"
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
  ]
    .filter(Boolean)
    .join("");

  return `<li class="a-guest">
    <div class="a-guest-who">
      <span class="a-guest-name">${escape(guest.name ?? guest.email)}${
        guest.isAdmin ? ' <span class="a-state a-state--admin">admin</span>' : ""
      }</span>
      <span class="a-note">
        ${
          guest.email
            ? escape(guest.email)
            : '<span class="a-state a-state--noemail">no email yet</span>'
        }${guest.company ? ` &middot; ${escape(guest.company)}` : ""}
      </span>
      <span class="a-note">
        <span class="a-state a-state--${escape(state.label)}">${escape(state.label)}</span>
        ${state.hint ? escape(state.hint) : ""}
        ${guest.selfRegistered ? "&middot; self-registered" : "&middot; added by an admin"}
      </span>
    </div>

    ${badgeCell({ guest, hidden })}

    ${extras ? `<div class="a-guest-more">${extras}</div>` : ""}
  </li>`;
}

/** 1–20 of 87, and the way to the rest of them. */
function paging({ total, page, per, q }) {
  if (!total) return "";

  const pages = Math.max(1, Math.ceil(total / per));
  const from = total ? (page - 1) * per + 1 : 0;
  const to = Math.min(total, page * per);
  const href = (p, size = per) =>
    `/admin/attendees?page=${p}&per=${size}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  const sizes = [10, 20, 50]
    .map(
      (size) =>
        `<a class="a-chip${size === per ? " a-chip--on" : ""}" href="${escape(href(1, size))}">${size}</a>`
    )
    .join("");

  return `<div class="a-paging">
    <span class="a-count">${from}&ndash;${to} of ${total}</span>
    <span class="a-paging-sizes">Show ${sizes}</span>
    <span class="a-paging-steps">
      ${page > 1 ? `<a class="a-chip" href="${escape(href(page - 1))}">&larr; Previous</a>` : ""}
      ${pages > 1 ? `<span class="a-count">page ${page} of ${pages}</span>` : ""}
      ${page < pages ? `<a class="a-chip" href="${escape(href(page + 1))}">Next &rarr;</a>` : ""}
    </span>
  </div>`;
}

export function attendeesPage({
  guests,
  capacity,
  categories = [],
  speakerSlugs = [],
  session,
  token,
  flash = null,
  q = "",
  total = null,
  page = 1,
  per = 20
}) {
  // The store returns them in category order, so grouping is a matter of
  // noticing where one category ends.
  const groups = [];
  for (const guest of guests) {
    const last = groups[groups.length - 1];
    if (last && last.slug === guest.category) last.guests.push(guest);
    else {
      groups.push({
        slug: guest.category,
        label: guest.categoryLabel ?? guest.category,
        colour: guest.categoryColour,
        guests: [guest]
      });
    }
  }

  const grouped = groups
    .map(
      (g) => `<section class="a-group">
        <h3 class="a-group-head">
          <span class="a-badgedot" style="background:${escape(g.colour)}"></span>
          ${escape(g.label)}
          <span class="a-count">${g.guests.length}</span>
        </h3>
        <ul class="a-guests">${g.guests
          .map((guest) => row({ guest, token, speakerSlugs }))
          .join("")}</ul>
      </section>`
    )
    .join("");

  const meters = capacity
    .map(
      (c) => `<li class="a-row">
        <span class="a-row-name">
          <span class="a-badgedot" style="background:${escape(c.colour)}"></span>
          ${escape(c.label)}${
            c.numbered ? ` &mdash; numbers ${c.from}&ndash;${c.to}` : " &mdash; unnumbered"
          }${c.note ? ` &middot; ${escape(c.note)}` : ""}</span>
        <span class="a-count">${
          c.numbered
            ? `${c.issued} of ${c.limit} taken${c.issued >= c.limit ? " &middot; full" : ""}`
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
      <p class="a-lede">Anyone can create an account. Adding somebody here puts
      them in a category, which attributes their badge at the same time — a
      numbered category takes the next number in its range. They claim it in
      their own profile, and once claimed it is fixed.</p>

      <ul class="a-list">${meters}</ul>
      <p class="a-note"><a href="/admin/badges">Print badges</a> &nbsp;·&nbsp;
      <a href="/admin/categories">Manage badge categories</a></p>

      <form method="get" action="/admin/attendees" class="a-inline a-search">
        <input name="q" value="${escape(q)}" placeholder="Search name, email or company"
               aria-label="Search">
        <button>Search</button>
        ${q ? '<a class="a-count" href="/admin/attendees">Clear</a>' : ""}
      </form>

      <h2>Add someone directly</h2>
      <p class="a-note">For the people the organisers invite. An address entered
      here counts as vouched for, so it needs no confirmation click. The badge
      is attributed as the account is created — untick that if this is somebody
      who is not being given one, and it can still be attributed later from
      their row. Leave the address out if you have not got it yet and give a
      name instead: they cannot sign in until it is filled in, and everything
      else about them works.</p>
      <form method="post" action="/admin/attendees" class="a-form a-form--inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="create">
        <input name="email" type="email" placeholder="Email (optional)" aria-label="Email">
        <input name="firstName" placeholder="First name" aria-label="First name">
        <input name="lastName" placeholder="Surname" aria-label="Surname">
        <input name="company" placeholder="Company" aria-label="Company">
        <select name="category" aria-label="Badge category" required>
          <option value="" selected disabled>Type…</option>
          ${categoryOptions(categories)}
        </select>
        <label class="a-check">
          <input type="checkbox" name="badge" value="yes" checked>
          <span>Attribute a badge</span>
        </label>
        <label class="a-check">
          <input type="checkbox" name="sendClaim" value="yes" checked>
          <span>Email them a link to set a password</span>
        </label>
        <button class="a-btn">Add</button>
      </form>

      <h2>The published speakers</h2>
      <p class="a-note">Twenty-six speakers are on the public page and most have
      never given an address. This makes an account and a badge for each one who
      has not got one, taking their name, company and title from the page. They
      cannot sign in until an address is filled in — everything else about them
      works, and you can add the address here as it arrives.</p>
      <form method="post" action="/admin/attendees" class="a-form--inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="importSpeakers">
        <button class="a-btn">Add the published speakers</button>
      </form>

      <h2>Add several at once</h2>
      <p class="a-note">Paste a CSV, a block copied from a spreadsheet, or just a
      column of addresses. A header row is used if there is one; without one the
      address is found wherever it sits. You will see what was understood before
      anything is created.
      &nbsp;<a href="/admin/attendees/example.csv" download>Download an example CSV</a></p>
      <form method="post" action="/admin/attendees" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="importPreview">
        <textarea name="paste" rows="6" class="a-paste" aria-label="Pasted guest list"
                  placeholder="Email,First name,Surname,Company,Position&#10;ada@example.com,Ada,Lovelace,Analytical Engines,Mathematician"></textarea>
        <div class="a-form--inline">
          <select name="category" aria-label="Badge category for everyone in this paste" required>
            <option value="" selected disabled>Type for all of them…</option>
            ${categoryOptions(categories, { plural: true })}
          </select>
          <label class="a-check">
            <input type="checkbox" name="badge" value="yes" checked>
            <span>Attribute a badge each</span>
          </label>
          <label class="a-check">
            <input type="checkbox" name="sendClaim" value="yes">
            <span>Email each of them a link to set a password</span>
          </label>
          <button class="a-btn">Read the list</button>
        </div>
      </form>

      <h2>${total ?? guests.length} account${(total ?? guests.length) === 1 ? "" : "s"}${
        q ? ` matching &ldquo;${escape(q)}&rdquo;` : ""
      }</h2>
      ${paging({ total: total ?? guests.length, page, per, q })}
      ${grouped || '<p class="a-note">Nobody yet.</p>'}
      ${guests.length ? paging({ total: total ?? guests.length, page, per, q }) : ""}

      <p><a class="a-btn" href="/admin">Back to collections</a></p>`
  });
}

/** A file to start from, rather than a format to guess at. */
export const EXAMPLE_CSV = `Email,First name,Surname,Company,Position
ada@example.com,Ada,Lovelace,Analytical Engines,Mathematician
grace@example.com,Grace,Hopper,US Navy,Rear Admiral
katherine@example.com,Katherine,Johnson,NASA,Aerospace Technologist
`;

/**
 * What the paste was understood to mean, before anything is created.
 *
 * A preview rather than a straight import because the failure that matters is
 * not a rejected row -- it is a hundred rows accepted with the columns one
 * place out, which reads perfectly well in a success message.
 */
export function importPreviewPage({
  parsed,
  existing,
  category,
  categoryLabel,
  sendClaim,
  badge = false,
  paste,
  session,
  token
}) {
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
          ? `<h2>Will be added as ${escape(categoryLabel ?? category)}${
              badge ? ", with a badge each" : ", without badges"
            }</h2>
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
        <input type="hidden" name="category" value="${escape(category)}">
        ${sendClaim ? '<input type="hidden" name="sendClaim" value="yes">' : ""}
        ${badge ? '<input type="hidden" name="badge" value="yes">' : ""}
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
