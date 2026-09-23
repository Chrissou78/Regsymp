/**
 * What a seat costs, and who has paid for one.
 *
 * A price belongs to an event and a badge category together: a VIP seat at
 * Davos is not a VIP seat at Mallorca, and a speaker seat may be free at one
 * and paid at the other. No row means not for sale, which is the default --
 * a category nobody has priced should never quietly go on sale.
 *
 * Amounts are in minor units throughout, the way Stripe counts them. They are
 * turned into something readable at the edges and nowhere else, because a
 * decimal that travels through three functions comes back rounded.
 */

/** Zero-decimal currencies, where 500 means five hundred, not five. */
const WHOLE = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

const SYMBOL = { eur: "€", gbp: "£", usd: "$", chf: "CHF " };

export function minorUnits(currency) {
  return WHOLE.has(String(currency ?? "").toLowerCase()) ? 1 : 100;
}

/** "€500" or "€499.50" — trailing zeroes dropped, because most prices are round. */
export function formatAmount(amount, currency = "eur") {
  const code = String(currency ?? "eur").toLowerCase();
  const per = minorUnits(code);
  const value = Number(amount) / per;
  const text = per === 1 ? String(value) : value.toFixed(2).replace(/\.00$/, "");
  return `${SYMBOL[code] ?? code.toUpperCase() + " "}${text}`;
}

/** The same number without a symbol, for putting back into a form field. */
export function plainAmount(amount, currency = "eur") {
  const per = minorUnits(currency);
  const value = Number(amount) / per;
  return per === 1 ? String(value) : value.toFixed(2).replace(/\.00$/, "");
}

/**
 * Read a price as a person types it: "500", "500.00", "€500", "1,250.50".
 *
 * Typed by hand into an admin form, so it accepts what a person writes rather
 * than insisting on minor units — asking an organiser to enter 50000 for five
 * hundred euro is how a seat ends up costing five thousand.
 */
export function parseAmount(input, currency = "eur") {
  const text = String(input ?? "")
    .replace(/[^\d.,-]/g, "")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(",", ".")
    .trim();
  if (!text) throw new Error("Give a price, or clear it to take the seats off sale.");

  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error("A price has to be more than nothing.");

  const per = minorUnits(currency);
  const minor = Math.round(value * per);
  if (per === 100 && Math.abs(value * 100 - minor) > 0.001) {
    throw new Error("A price can go to two decimal places, no further.");
  }
  if (minor >= 100000000) throw new Error("That price looks like a mistake.");
  return minor;
}

function presentPrice(row) {
  if (!row) return null;
  return {
    eventSlug: row.event_slug,
    category: row.category,
    label: row.category_label ?? row.category,
    colour: row.colour ?? null,
    amount: Number(row.amount),
    currency: row.currency,
    display: formatAmount(row.amount, row.currency),
    onSale: row.on_sale,
    updatedAt: row.updated_at
  };
}

function presentPayment(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    stripeEvent: row.stripe_event,
    eventSlug: row.event_slug,
    category: row.category,
    label: row.category_label ?? row.category,
    email: row.email,
    name: row.name,
    amount: Number(row.amount),
    currency: row.currency,
    display: formatAmount(row.amount, row.currency),
    status: row.status,
    attendeeId: row.attendee_id ? Number(row.attendee_id) : null,
    ticketId: row.ticket_id ? Number(row.ticket_id) : null,
    ticketNumber: row.ticket_number ?? null,
    createdAt: row.created_at,
    paidAt: row.paid_at
  };
}

export function createPrices({ db }) {
  return {
    /**
     * Every category, with its price if it has one.
     *
     * The unpriced ones are in the list too: the admin page is where a price
     * is set, so the categories without one are exactly what it has to show.
     */
    async forEvent(slug) {
      const { rows } = await db.query(
        `select c.slug as category, c.label as category_label, c.colour, c.sort,
                p.amount, p.currency, p.on_sale, p.updated_at,
                $1::text as event_slug
           from badge_categories c
           left join event_prices p
             on p.category = c.slug and p.event_slug = $1
          order by c.sort, c.label`,
        [String(slug)]
      );
      return rows.map((r) => ({
        category: r.category,
        label: r.category_label,
        colour: r.colour,
        priced: r.amount !== null,
        amount: r.amount === null ? null : Number(r.amount),
        currency: r.currency ?? "eur",
        display: r.amount === null ? null : formatAmount(r.amount, r.currency),
        onSale: Boolean(r.on_sale),
        updatedAt: r.updated_at
      }));
    },

    /** What somebody can actually buy today. */
    async onSaleFor(slug) {
      const { rows } = await db.query(
        `select p.*, c.label as category_label, c.colour, c.note
           from event_prices p
           join badge_categories c on c.slug = p.category
          where p.event_slug = $1 and p.on_sale
          order by c.sort, c.label`,
        [String(slug)]
      );
      return rows.map((r) => ({ ...presentPrice(r), note: r.note }));
    },

    /**
     * One price, read at the moment of purchase.
     *
     * Deliberately re-read rather than trusted from the form: the amount the
     * browser sends is a suggestion, and a suggestion is not a price.
     */
    async priceFor(slug, category) {
      const { rows } = await db.query(
        `select p.*, c.label as category_label, c.colour
           from event_prices p
           join badge_categories c on c.slug = p.category
          where p.event_slug = $1 and p.category = $2 and p.on_sale`,
        [String(slug), String(category)]
      );
      return presentPrice(rows[0]);
    },

    async set(slug, category, { amount, currency = "eur", onSale = false }) {
      const code = String(currency ?? "eur").trim().toLowerCase();
      if (!/^[a-z]{3}$/.test(code)) throw new Error("A currency is three letters, like eur.");

      const minor = typeof amount === "number" ? amount : parseAmount(amount, code);

      const { rows } = await db
        .query(
          `insert into event_prices (event_slug, category, amount, currency, on_sale)
           values ($1, $2, $3, $4, $5)
           on conflict (event_slug, category) do update
              set amount = excluded.amount,
                  currency = excluded.currency,
                  on_sale = excluded.on_sale,
                  updated_at = now()
           returning *`,
          [String(slug), String(category), minor, code, Boolean(onSale)]
        )
        .catch((err) => {
          if (err.code === "23503") throw new Error("There is no such event or badge category.");
          throw err;
        });
      return presentPrice(rows[0]);
    },

    /** Take the price away entirely, which is how a seat stops being for sale. */
    async clear(slug, category) {
      await db.query("delete from event_prices where event_slug = $1 and category = $2", [
        String(slug),
        String(category)
      ]);
    },

    // ------------------------------------------------------------- payments

    /**
     * Note that somebody has opened a payment page.
     *
     * Written before they reach Stripe, so a payment that completes always has
     * a row to land in -- a webhook arriving for a session this site has never
     * heard of is a much harder thing to answer than a pending row.
     */
    async open({ sessionId, eventSlug, category, email, name, amount, currency }) {
      const { rows } = await db.query(
        `insert into payments (session_id, event_slug, category, email, name, amount, currency)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (session_id) do nothing
         returning *`,
        [
          String(sessionId),
          eventSlug ?? null,
          category ?? null,
          String(email ?? "").trim().toLowerCase() || null,
          String(name ?? "").trim() || null,
          Number(amount),
          String(currency ?? "eur").toLowerCase()
        ]
      );
      return presentPayment(rows[0]);
    },

    async bySession(sessionId) {
      const { rows } = await db.query(
        `select p.*, c.label as category_label, t.number as ticket_number
           from payments p
           left join badge_categories c on c.slug = p.category
           left join tickets t on t.id = p.ticket_id
          where p.session_id = $1`,
        [String(sessionId)]
      );
      return presentPayment(rows[0]);
    },

    /**
     * Mark a payment as taken, once and only once.
     *
     * The update is conditional on the row still being pending and returns
     * nothing if it is not: Stripe retries a webhook for three days and says
     * plainly that an endpoint may see the same event twice, so "did this
     * already happen?" has to be answered by the database rather than by the
     * caller's memory.
     */
    async markPaid({ sessionId, stripeEvent, email, name }) {
      const { rows } = await db.query(
        `update payments
            set status = 'paid',
                paid_at = now(),
                stripe_event = coalesce($2, stripe_event),
                email = coalesce(nullif(lower($3), ''), email),
                name = coalesce(nullif($4, ''), name)
          where session_id = $1 and status = 'pending'
         returning *`,
        [String(sessionId), stripeEvent ?? null, String(email ?? ""), String(name ?? "")]
      );
      return presentPayment(rows[0]);
    },

    async markFailed(sessionId, status = "expired") {
      await db.query(
        "update payments set status = $2 where session_id = $1 and status = 'pending'",
        [String(sessionId), status]
      );
    },

    /** Tie the payment to the badge it bought, so the two can be read together. */
    async attach(sessionId, { attendeeId = null, ticketId = null }) {
      await db.query(
        `update payments
            set attendee_id = coalesce($2, attendee_id),
                ticket_id = coalesce($3, ticket_id)
          where session_id = $1`,
        [String(sessionId), attendeeId, ticketId]
      );
    },

    async list({ eventSlug = null, status = null, limit = 100, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select p.*, c.label as category_label, t.number as ticket_number
           from payments p
           left join badge_categories c on c.slug = p.category
           left join tickets t on t.id = p.ticket_id
          where ($1::text is null or p.event_slug = $1)
            and ($2::text is null or p.status = $2)
          order by p.created_at desc
          limit $3 offset $4`,
        [eventSlug, status, Number(limit), Math.max(0, Number(offset) || 0)]
      );
      return rows.map(presentPayment);
    },

    /** Taken, and by category, which is the only figure anybody asks for. */
    async takings(eventSlug = null) {
      const { rows } = await db.query(
        `select category, currency, count(*)::int as sold, sum(amount)::bigint as total
           from payments
          where status = 'paid' and ($1::text is null or event_slug = $1)
          group by category, currency
          order by category`,
        [eventSlug]
      );
      return rows.map((r) => ({
        category: r.category,
        currency: r.currency,
        sold: r.sold,
        total: Number(r.total),
        display: formatAmount(Number(r.total), r.currency)
      }));
    }
  };
}
