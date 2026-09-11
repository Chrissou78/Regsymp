import { escape, layout } from "./render.js";
import { inkOn } from "./ink.js";

/**
 * Printable access badges, and the categories they come in.
 *
 * The sheet is deliberately plain HTML with a print stylesheet rather than a
 * generated PDF: it needs no dependency, it reflows if the badge stock
 * changes, and whoever is printing can see exactly what will come out before
 * committing paper to it.
 *
 * Each badge carries the same QR as the ticket — pointing at /t/<code> on
 * this site — so one scan works whether somebody presents a badge, a phone,
 * or a wallet pass.
 */

function badge({ guest, ticket, qr }) {
  const ink = inkOn(ticket.colour);
  const name = guest.name ?? guest.email;

  return `<article class="b-badge">
    <header class="b-band" style="background:${escape(ticket.colour)};color:${ink}">
      <span class="b-cat">${escape(ticket.categoryLabel)}</span>
      ${ticket.number !== null ? `<span class="b-num">${ticket.number}</span>` : ""}
    </header>

    <div class="b-main">
      <p class="b-name">${escape(name)}</p>
      ${guest.company ? `<p class="b-org">${escape(guest.company)}</p>` : ""}
      ${guest.position ? `<p class="b-role">${escape(guest.position)}</p>` : ""}
    </div>

    <footer class="b-foot">
      <div class="b-qr">${qr}</div>
      <div class="b-event">
        <p class="b-mark">REGSYMP</p>
        <p class="b-when">Palma de Mallorca<br>14–15 September 2026</p>
        ${
          ticket.areas?.length
            ? `<p class="b-areas">${ticket.areas
                .map((a) => escape(a.replace(/^side:/, "")))
                .join(" · ")}</p>`
            : ""
        }
      </div>
    </footer>

    <p class="b-by">powered by
      <img src="/assets/images/onchainlabs.png" alt="OnChainLabs" width="1012" height="306">
    </p>
  </article>`;
}

export function badgeSheetPage({ badges, session, filter = null, categories = [] }) {
  const cards = badges.map(badge).join("");

  const chips = categories
    .map(
      (c) =>
        `<a class="a-chip${filter === c.slug ? " a-chip--on" : ""}" href="/admin/badges?category=${escape(
          c.slug
        )}"><span class="a-badgedot" style="background:${escape(c.colour)}"></span>${escape(
          c.label
        )}</a>`
    )
    .join("");

  return layout({
    title: "Badges",
    user: session.user,
    body: `<div class="b-controls">
        <h1>Badges</h1>
        <p class="a-lede">${badges.length} badge${badges.length === 1 ? "" : "s"} to print${
          filter ? ` in ${escape(filter)}` : ""
        }. Print at A4 with margins off; each sheet holds eight.</p>
        <p class="a-note">
          <a class="a-chip${filter ? "" : " a-chip--on"}" href="/admin/badges">Everyone</a>
          ${chips}
        </p>
        <p class="a-note">
          <button class="a-btn" onclick="window.print()">Print</button>
          &nbsp;·&nbsp; <a href="/admin/attendees">Back to the guest list</a>
        </p>
        ${
          badges.length
            ? ""
            : '<p class="a-note">Nobody has a badge yet. Issue them from the guest list.</p>'
        }
      </div>

      <div class="b-sheet">${cards}</div>`
  });
}

export function categoriesPage({ categories, session, token, flash = null }) {
  const rows = categories
    .map(
      (c) => `<li class="a-cred">
      <div class="a-cred-top">
        <span class="a-cred-name">
          <span class="a-badgedot" style="background:${escape(c.colour)}"></span>
          ${escape(c.label)}
        </span>
        <span class="a-cred-state a-cred-state--${c.issued ? "set" : "unset"}">
          ${c.issued} issued${c.numbered ? ` of ${c.limit}` : ""}
        </span>
      </div>

      <p class="a-cred-help">
        <code>${escape(c.slug)}</code> &middot;
        ${c.numbered ? `numbers ${c.from}–${c.to}` : "unnumbered"}
        ${c.note ? ` &middot; badges say &ldquo;${escape(c.note)}&rdquo;` : ""}
        ${c.protected ? " &middot; built in, cannot be removed" : ""}
      </p>

      <form method="post" action="/admin/categories" class="a-form--inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="edit">
        <input type="hidden" name="slug" value="${escape(c.slug)}">
        <input name="label" value="${escape(c.label)}" aria-label="Label" required>
        <input name="from" value="${c.from ?? ""}" placeholder="first no." aria-label="First number"
               inputmode="numeric" size="6">
        <input name="to" value="${c.to ?? ""}" placeholder="last no." aria-label="Last number"
               inputmode="numeric" size="6">
        <input name="colour" value="${escape(c.colour)}" aria-label="Colour" size="9">
        <input name="note" value="${escape(c.note ?? "")}" placeholder="note on the badge"
               aria-label="Note shown on every badge in this category">
        <input name="sort" value="${c.sort}" aria-label="Order" size="3" inputmode="numeric">
        <button class="a-btn">Save</button>
        ${
          c.protected
            ? ""
            : `<button name="action" value="remove" class="a-danger"
                       onsubmit="return confirm('Remove ${escape(c.label)}?')">Remove</button>`
        }
      </form>
    </li>`
    )
    .join("");

  return layout({
    title: "Badge categories",
    user: session.user,
    flash,
    body: `<h1>Badge categories</h1>
      <p class="a-lede">Speaker, VIP and Visitor to begin with. Add your own —
      Press, Staff, Sponsor — and give each its own block of numbers, or leave
      the numbers blank for a badge that carries a category but no place in a
      sequence.</p>

      <ul class="a-creds">${rows}</ul>

      <h2>Add a category</h2>
      <p class="a-note">Ranges must not overlap: two categories drawing from the
      same numbers would hand two people the same badge number. A note is
      printed on every badge in the category and shown on the ticket and the
      wallet pass — VIP says &ldquo;Pre-event dinner&rdquo;.</p>
      <form method="post" action="/admin/categories" class="a-form--inline">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="add">
        <input name="slug" placeholder="press" aria-label="Identifier" required>
        <input name="label" placeholder="Press" aria-label="Label" required>
        <input name="from" placeholder="first no." aria-label="First number" size="6" inputmode="numeric">
        <input name="to" placeholder="last no." aria-label="Last number" size="6" inputmode="numeric">
        <input name="colour" placeholder="#7A5E22" aria-label="Colour" size="9">
        <input name="note" placeholder="note on the badge" aria-label="Note shown on every badge">
        <input name="sort" placeholder="4" aria-label="Order" size="3" inputmode="numeric">
        <button class="a-btn">Add</button>
      </form>

      <p class="a-note">Leaving both number fields blank makes a category
      unnumbered, which is how Speaker starts: a badge that says what somebody
      is rather than where they sit in a count.</p>

      <p><a class="a-btn" href="/admin/attendees">Back to the guest list</a></p>`
  });
}
