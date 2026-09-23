import { escape, layout } from "./render.js";
import { STATUSES } from "./the-33.js";

/**
 * Who wants a seat at The 33.
 *
 * Thirty-three places and a table, so the only figure that matters is how many
 * people want each edition — that goes at the top. Below it, the people, in
 * the order they asked.
 *
 * Nothing here invites anybody. Marking somebody invited records that a chair
 * decided to; it does not send anything, create an account or issue a badge,
 * because an invitation to a private dinner is a letter from a person.
 */

const STATE = {
  new: { label: "new", tone: "draft" },
  invited: { label: "invited", tone: "live" },
  declined: { label: "declined", tone: "past" },
  archived: { label: "archived", tone: "past" }
};

const when = (value) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "—";

function row({ person, token }) {
  const state = STATE[person.status] ?? STATE.new;
  const hidden = `<input type="hidden" name="csrf" value="${escape(token)}">
    <input type="hidden" name="id" value="${person.id}">`;

  return `<li class="a-guest">
    <div class="a-guest-who">
      <span class="a-guest-name">
        ${escape(person.name)}
        <span class="a-state a-state--event-${escape(state.tone)}">${escape(state.label)}</span>
      </span>
      <span class="a-note">
        <a href="mailto:${escape(person.email)}">${escape(person.email)}</a>
        &middot; ${escape(person.company)}
      </span>
      <span class="a-note">${escape(when(person.createdAt))}${
        person.handledBy ? ` &middot; ${escape(person.status)} by ${escape(person.handledBy)}` : ""
      }</span>
      ${person.note ? `<span class="a-note">${escape(person.note)}</span>` : ""}
    </div>

    <div class="a-badgecell">
      <span class="a-count">${person.editions
        .map((e) => escape(e.split(" — ")[0]))
        .join(", ")}</span>
    </div>

    <div class="a-guest-more">
      ${STATUSES.filter((s) => s !== person.status)
        .map(
          (s) => `<form method="post" action="/admin/interest" class="a-inline">
            ${hidden}<input type="hidden" name="status" value="${s}">
            <button class="a-count">Mark ${escape(s)}</button>
          </form>`
        )
        .join("")}
    </div>
  </li>`;
}

export function interestPage({
  people,
  demand = [],
  editions = [],
  status = null,
  edition = null,
  total = 0,
  session,
  token,
  flash = null
}) {
  return layout({
    title: "The 33",
    user: session.user,
    flash,
    body: `<h1>The 33</h1>
      <p class="a-lede">People who asked to be considered, from the cards on
      <a href="/next/">the editions page</a>. Nothing here invites anybody:
      marking somebody invited records that you decided to, and the letter is
      still yours to write.</p>

      ${
        demand.length
          ? `<ul class="a-stats">${demand
              .map(
                (d) =>
                  `<li><strong>${d.wanted}</strong> <span class="a-note">${escape(
                    d.edition.split(" — ")[0]
                  )}</span></li>`
              )
              .join("")}</ul>`
          : ""
      }

      <form method="get" action="/admin/interest" class="a-form a-form--inline">
        <div class="a-field">
          <label for="f-edition">Edition</label>
          <select id="f-edition" name="edition">
            <option value="">Any edition</option>
            ${editions
              .map(
                (e) =>
                  `<option value="${escape(e)}"${e === edition ? " selected" : ""}>${escape(
                    e
                  )}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="a-field">
          <label for="f-status">Status</label>
          <select id="f-status" name="status">
            ${["", ...STATUSES]
              .map(
                (s) =>
                  `<option value="${escape(s)}"${s === (status ?? "") ? " selected" : ""}>${escape(
                    s || "Any"
                  )}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="a-actions">
          <button class="a-btn" type="submit">Show</button>
          <a class="a-count" href="/admin/interest.csv">Download as CSV</a>
        </div>
      </form>

      ${
        people.length
          ? `<p class="a-note">${people.length} of ${total} shown.</p>
             <ul class="a-guests">${people.map((person) => row({ person, token })).join("")}</ul>`
          : '<p class="a-note">Nobody yet.</p>'
      }

      <p><a href="/admin">Back to collections</a></p>`
  });
}

/**
 * The same list, as a file.
 *
 * Because the first thing anybody will do with thirty-three names is put them
 * in a spreadsheet beside a seating plan.
 */
export function interestCsv(people) {
  const cell = (value) => {
    const text = String(value ?? "");
    // Quote everything: a company name with a comma in it is not unusual, and
    // a leading = would be read as a formula by a spreadsheet.
    return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  };

  const rows = [
    ["Name", "Email", "Company", "Editions", "Note", "Status", "Registered"],
    ...people.map((p) => [
      p.name,
      p.email,
      p.company,
      p.editions.join("; "),
      p.note ?? "",
      p.status,
      p.createdAt ? new Date(p.createdAt).toISOString() : ""
    ])
  ];

  // A BOM, so Excel opens it as UTF-8 rather than mangling every accent.
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
