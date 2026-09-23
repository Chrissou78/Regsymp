import { escape, layout } from "./render.js";
import { plainAmount } from "./prices.js";

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

const CURRENCIES = ["eur", "gbp", "usd", "chf"];

/**
 * What a seat at this event costs.
 *
 * One row per badge category, priced or not. A category with no price is not
 * for sale, and that is the default: the alternative -- everything on sale at
 * zero until somebody says otherwise -- has an obvious failure mode.
 *
 * Priced and on sale are separate on purpose. Prices are agreed weeks before
 * the seats open, and "decide the number" and "start taking money" are not the
 * same decision.
 */
function seatRow({ seat, event, token }) {
  const money = seat.priced ? plainAmount(seat.amount, seat.currency) : "";

  return `<li class="a-guest">
    <div class="a-guest-who">
      <span class="a-guest-name">
        ${escape(seat.label)}
        ${
          seat.priced && seat.onSale
            ? '<span class="a-state a-state--event-live">on sale</span>'
            : seat.priced
              ? '<span class="a-state">priced, not on sale</span>'
              : '<span class="a-state">not for sale</span>'
        }
      </span>
      <span class="a-note">${
        seat.priced
          ? escape(`${seat.display} — buyers get a ${seat.label} badge automatically once they have paid.`)
          : "No price, so these seats cannot be bought."
      }</span>
    </div>

    <form method="post" action="/admin/events/${escape(event.slug)}" class="a-badgecell a-inline">
      <input type="hidden" name="csrf" value="${escape(token)}">
      <input type="hidden" name="action" value="price">
      <input type="hidden" name="category" value="${escape(seat.category)}">

      <label class="a-sr" for="p-${escape(seat.category)}">Price</label>
      <input id="p-${escape(seat.category)}" name="amount" type="text" inputmode="decimal"
             value="${escape(money)}" placeholder="500" size="8">

      <label class="a-sr" for="c-${escape(seat.category)}">Currency</label>
      <select id="c-${escape(seat.category)}" name="currency">
        ${CURRENCIES.map(
          (code) =>
            `<option value="${code}"${seat.currency === code ? " selected" : ""}>${code.toUpperCase()}</option>`
        ).join("")}
      </select>

      <label class="a-check">
        <input type="checkbox" name="onSale" value="yes"${seat.onSale ? " checked" : ""}>
        <span>On sale</span>
      </label>

      <button class="a-btn" type="submit">Save</button>
      ${
        seat.priced
          ? `<button class="a-danger" type="submit" name="action" value="unprice"
                     onclick="return confirm('Take ${escape(seat.label)} off sale and forget the price?')">Clear</button>`
          : ""
      }
    </form>
  </li>`;
}

export function eventPage({ event, seats = [], stripeReady = false, session, token, flash = null }) {
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

      <form method="post" action="/admin/events/${escape(event.slug)}"
            enctype="multipart/form-data" class="a-form">
        <input type="hidden" name="csrf" value="${escape(token)}">

        <h2 class="a-subhead">What it is</h2>
        ${field({ name: "name", label: "Name", value: event.name, attrs: "required" })}
        ${field({ name: "series", label: "Series", value: event.series, help: "e.g. The 33, or The Ninety Nine. Shown beside the event." })}
        ${field({ name: "tagline", label: "One line", value: event.tagline, help: "The sentence under it in the “coming next” list." })}

        <div class="a-field">
          <label for="f-summary">Summary</label>
          <textarea id="f-summary" name="summary" rows="4">${escape(event.summary ?? "")}</textarea>
        </div>

        <div class="a-field">
          <label for="f-photo">Photograph</label>
          ${
            event.imagePath
              ? `<img class="a-thumb" src="/assets/images/${escape(event.imagePath)}"
                   alt="" width="160" height="160">`
              : ""
          }
          <input id="f-photo" name="photo" type="file"
                 accept="image/jpeg,image/png,image/webp">
          <span class="a-help">The square on The 33. Upload one and it replaces
          what is there; leave it empty and nothing changes.</span>
        </div>

        <!-- Kept so a save with no upload does not clear the picture, and so
             a path can still be typed when the file is already on the site. -->
        ${field({
          name: "imagePath",
          label: "…or its path",
          value: event.imagePath,
          help: "Under /assets/images/ — e.g. the33/london-2026.jpg"
        })}

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
      </form>

      <h2 class="a-subhead">Seats and prices</h2>
      <p class="a-note">
        A seat is on sale when it has a price and the box is ticked. Paying for
        one issues that badge automatically, in the category paid for.
        ${
          stripeReady
            ? `Payments are taken by Stripe, on Stripe’s own page — no card details reach this site. The public page is <a href="/tickets">/tickets</a>.`
            : 'Nothing can be bought yet: <strong>STRIPE_SECRET_KEY</strong> has not been set in <a href="/admin/credentials">service credentials</a>. Prices can be agreed here in the meantime.'
        }
      </p>
      <ul class="a-guests">${seats.map((seat) => seatRow({ seat, event, token })).join("")}</ul>
      <p class="a-note"><a href="/admin/payments?event=${escape(event.slug)}">Payments for this event</a></p>`
  });
}
