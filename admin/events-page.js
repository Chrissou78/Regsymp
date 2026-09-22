import { escape, layout } from "./render.js";

/**
 * The events the site can be about.
 *
 * One is live and the site is about that one. The rest are drafts being
 * written, or events that have happened. Making one live stands the previous
 * one down, which is stated on the button rather than discovered afterwards.
 */

const STATUS = {
  live: { label: "live", hint: "the site is about this one" },
  draft: { label: "draft", hint: "not published" },
  past: { label: "past", hint: "" }
};

function field({ name, label, value = "", help = "", type = "text", attrs = "" }) {
  return `<div class="a-field">
    <label for="f-${escape(name)}">${escape(label)}</label>
    <input id="f-${escape(name)}" name="${escape(name)}" type="${escape(type)}"
           value="${escape(value ?? "")}" ${attrs}>
    ${help ? `<span class="a-help">${escape(help)}</span>` : ""}
  </div>`;
}

function row({ event, token }) {
  const state = STATUS[event.status] ?? STATUS.draft;
  const hidden = `<input type="hidden" name="csrf" value="${escape(token)}">
    <input type="hidden" name="slug" value="${escape(event.slug)}">`;

  return `<li class="a-guest">
    <div class="a-guest-who">
      <span class="a-guest-name">
        ${escape(event.name)}
        <span class="a-state a-state--event-${escape(event.status)}">${escape(state.label)}</span>
      </span>
      <span class="a-note">
        ${escape([event.city, event.country].filter(Boolean).join(", ") || "—")}
        &middot; ${escape(event.whenLabel)}
        ${event.series ? ` &middot; ${escape(event.series)}` : ""}
      </span>
      ${event.tagline ? `<span class="a-note">${escape(event.tagline)}</span>` : ""}
    </div>

    <div class="a-badgecell">
      ${
        event.upcoming
          ? '<span class="a-count">in “coming next”</span>'
          : '<span class="a-count">hidden from “coming next”</span>'
      }
      ${
        event.status === "live"
          ? '<span class="a-state a-state--event-live">on the site now</span>'
          : `<form method="post" action="/admin/events" class="a-inline"
                   onsubmit="return confirm('Make ${escape(event.name)} the live event? Whatever is live now is stood down.')">
               ${hidden}<input type="hidden" name="action" value="activate">
               <button class="a-btn">Make it live</button>
             </form>`
      }
    </div>

    <div class="a-guest-more">
      <a class="a-count" href="/admin/events/${escape(event.slug)}">Edit</a>
      <a class="a-count" href="/?preview=${escape(event.slug)}" target="_blank" rel="noopener">Preview the site</a>
      ${
        event.status === "live"
          ? ""
          : `<form method="post" action="/admin/events" class="a-inline"
                   onsubmit="return confirm('Remove ${escape(event.name)}?')">
               ${hidden}<input type="hidden" name="action" value="remove">
               <button class="a-danger">Remove</button>
             </form>`
      }
    </div>
  </li>`;
}

export function eventsPage({ events, session, token, flash = null }) {
  const live = events.find((e) => e.status === "live");

  return layout({
    title: "Events",
    user: session.user,
    flash,
    body: `<h1>Events</h1>
      <p class="a-lede">The site is about one event at a time. The others are
      drafts being written, or events that have happened. An event can be
      prepared months ahead and looked at before anybody else sees it.</p>

      <p class="a-note">${
        live
          ? `The site is currently about <strong>${escape(live.name)}</strong>, ${escape(live.whenLabel)}.`
          : "No event is live. The site has nothing to be about — a good moment for <a href=\"/admin/sleep\">sleep mode</a>."
      }</p>

      <ul class="a-guests">${events.map((event) => row({ event, token })).join("")}</ul>

      <h2>Add an event</h2>
      <p class="a-note">It starts as a draft. Nothing about the public site
      changes until you make it live.</p>
      <form method="post" action="/admin/events" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">
        <input type="hidden" name="action" value="create">
        <div class="a-form--inline">
          ${field({ name: "name", label: "Name", attrs: "required placeholder=\"RegSymp London\"" })}
          ${field({ name: "slug", label: "Identifier", attrs: "required placeholder=\"london-2026\"" })}
          ${field({ name: "city", label: "City", attrs: "placeholder=\"London\"" })}
          ${field({
            name: "whenLabel",
            label: "When",
            attrs: "required placeholder=\"November 2026\"",
            help: "As people read it. “Spring 2027” is a fine answer."
          })}
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Add as a draft</button></div>
      </form>

      <p><a href="/admin">Back to collections</a></p>`
  });
}

export function eventPage({ event, session, token, flash = null }) {
  return layout({
    title: event.name,
    user: session.user,
    flash,
    body: `<h1>${escape(event.name)}</h1>
      <p class="a-lede">
        <span class="a-state a-state--event-${escape(event.status)}">${escape(event.status)}</span>
        &middot; <code>${escape(event.slug)}</code>
        &middot; <a href="/?preview=${escape(event.slug)}" target="_blank" rel="noopener">Preview the site with this event</a>
      </p>

      <form method="post" action="/admin/events/${escape(event.slug)}" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">

        <h2 class="a-subhead">What it is</h2>
        ${field({ name: "name", label: "Name", value: event.name, attrs: "required" })}
        ${field({ name: "series", label: "Series", value: event.series, help: "e.g. The 33, or The Ninety Nine. Shown beside the event." })}
        ${field({ name: "tagline", label: "One line", value: event.tagline, help: "The sentence under it in the “coming next” list." })}

        <div class="a-field">
          <label for="f-summary">Summary</label>
          <textarea id="f-summary" name="summary" rows="4">${escape(event.summary ?? "")}</textarea>
        </div>

        <h2 class="a-subhead">Where and when</h2>
        <div class="a-form--inline">
          ${field({ name: "city", label: "City", value: event.city })}
          ${field({ name: "country", label: "Country", value: event.country })}
          ${field({ name: "venue", label: "Venue", value: event.venue })}
        </div>
        <div class="a-form--inline">
          ${field({ name: "whenLabel", label: "When", value: event.whenLabel, attrs: "required", help: "As people read it." })}
          ${field({ name: "startsOn", label: "Starts", value: event.startsOn ? String(event.startsOn).slice(0, 10) : "", type: "date", help: "Optional. Used for ordering." })}
          ${field({ name: "endsOn", label: "Ends", value: event.endsOn ? String(event.endsOn).slice(0, 10) : "", type: "date" })}
        </div>

        <h2 class="a-subhead">Where it appears</h2>
        <label class="a-check">
          <input type="checkbox" name="upcoming" value="yes"${event.upcoming ? " checked" : ""}>
          <span>Show in the “coming next” summary</span>
        </label>
        ${field({ name: "sort", label: "Order", value: event.sort, help: "Lower comes first in the list." })}

        <div class="a-actions">
          <button class="a-btn" type="submit">Save</button>
          <a class="a-count" href="/admin/events">Back to events</a>
        </div>
      </form>`
  });
}
