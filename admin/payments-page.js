import { escape, layout } from "./render.js";

/**
 * What has been paid, and what it bought.
 *
 * Stripe's own dashboard is the record of the money. This is the record of the
 * seats: which badge each payment issued, and — the only row anybody will
 * actually go looking for — which payment failed to issue one.
 */

const STATE = {
  paid: { label: "paid", tone: "live" },
  pending: { label: "pending", tone: "draft" },
  failed: { label: "failed", tone: "past" },
  expired: { label: "expired", tone: "past" },
  refunded: { label: "refunded", tone: "past" }
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

function row(payment) {
  const state = STATE[payment.status] ?? STATE.pending;

  // Two rows want somebody's attention: money taken with no badge behind it,
  // and money given back with the badge still standing. Neither is decided
  // here -- withdrawing a refunded seat is a decision about a person.
  const orphaned = payment.status === "paid" && !payment.ticketId;
  const refundedButHolding = payment.status === "refunded" && Boolean(payment.ticketId);

  return `<li class="a-guest${orphaned || refundedButHolding ? " a-guest--warn" : ""}">
    <div class="a-guest-who">
      <span class="a-guest-name">
        ${escape(payment.name || payment.email || "—")}
        <span class="a-state a-state--event-${escape(state.tone)}">${escape(state.label)}</span>
      </span>
      <span class="a-note">${escape(payment.email ?? "no address")} &middot; ${escape(
        payment.label ?? payment.category ?? "—"
      )} &middot; ${escape(payment.eventSlug ?? "—")}</span>
      <span class="a-note">${escape(when(payment.paidAt ?? payment.createdAt))}</span>
    </div>

    <div class="a-badgecell">
      <span class="a-count">${escape(payment.display)}</span>
      ${
        payment.ticketId
          ? `<span class="a-state">badge ${escape(
              payment.ticketNumber === null || payment.ticketNumber === undefined
                ? "issued"
                : `#${payment.ticketNumber}`
            )}</span>`
          : orphaned
            ? '<span class="a-state a-state--event-past">no badge issued</span>'
            : ""
      }
      ${
        refundedButHolding
          ? '<span class="a-state a-state--event-past">refunded, badge still valid</span>'
          : ""
      }
    </div>

    <div class="a-guest-more">
      <code class="a-note">${escape(payment.paymentIntent ?? payment.sessionId)}</code>
      ${
        payment.stripeAccount
          ? `<span class="a-note">into ${escape(payment.stripeAccount)}</span>`
          : ""
      }
    </div>
  </li>`;
}

export function paymentsPage({
  payments,
  takings = [],
  events = [],
  eventSlug = null,
  status = null,
  stripeReady = false,
  webhookReady = false,
  connected = null,
  session,
  flash = null
}) {
  return layout({
    title: "Payments",
    user: session.user,
    flash,
    body: `<h1>Payments</h1>
      <p class="a-lede">Seats bought through the site. Stripe holds the money;
      this holds the badges they bought. A badge belongs to the event it was
      bought for, so the same person may appear here once per event.</p>
      ${
        connected
          ? `<p class="a-note">Money goes to connected account
             <code>${escape(connected.account)}</code>, ${
               connected.mode === "direct"
                 ? "which is the merchant of record: its name on the statement, its balance, its liability."
                 : "as a transfer. This platform is the merchant of record."
             }</p>`
          : ""
      }

      ${
        stripeReady
          ? webhookReady
            ? ""
            : `<p class="a-note a-note--warn"><strong>No webhook secret.</strong>
               Payments can be taken but no badge will be issued, because Stripe's
               confirmation cannot be trusted without one. Set
               <code>STRIPE_WEBHOOK_SECRET</code> in
               <a href="/admin/credentials">service credentials</a>.</p>`
          : `<p class="a-note a-note--warn">Payments are switched off:
             <code>STRIPE_SECRET_KEY</code> has not been set in
             <a href="/admin/credentials">service credentials</a>.</p>`
      }

      ${
        takings.length
          ? `<ul class="a-stats">${takings
              .map(
                (t) =>
                  `<li><strong>${escape(t.display)}</strong> <span class="a-note">${escape(
                    t.category
                  )} &middot; ${t.sold} sold</span></li>`
              )
              .join("")}</ul>`
          : ""
      }

      <form method="get" action="/admin/payments" class="a-form a-form--inline">
        <div class="a-field">
          <label for="f-event">Event</label>
          <select id="f-event" name="event">
            <option value="">All events</option>
            ${events
              .map(
                (e) =>
                  `<option value="${escape(e.slug)}"${e.slug === eventSlug ? " selected" : ""}>${escape(
                    e.name
                  )}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="a-field">
          <label for="f-status">Status</label>
          <select id="f-status" name="status">
            ${["", "paid", "pending", "refunded", "failed", "expired"]
              .map(
                (s) =>
                  `<option value="${escape(s)}"${s === (status ?? "") ? " selected" : ""}>${escape(
                    s || "Any"
                  )}</option>`
              )
              .join("")}
          </select>
        </div>
        <div class="a-actions"><button class="a-btn" type="submit">Show</button></div>
      </form>

      ${
        payments.length
          ? `<ul class="a-guests">${payments.map(row).join("")}</ul>`
          : '<p class="a-note">Nothing yet.</p>'
      }

      <p><a href="/admin">Back to collections</a></p>`
  });
}
