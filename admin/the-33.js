/**
 * People who asked to be considered for The 33.
 *
 * Not a booking. The 33 is convened by invitation and the programme chairs
 * decide, so the card on the page registers interest and nothing more -- no
 * seat is held, no badge is issued, nothing is charged. Keeping that true is
 * the reason this is its own table rather than a pending attendee or an
 * unpaid payment: both of those are things somebody would later be tempted to
 * turn into an admission automatically.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX = { name: 120, email: 200, company: 160, note: 2000, source: 60 };

/** Bots submit near-instantly; people take a few seconds. */
const MIN_FILL_MS = 3000;

export const STATUSES = Object.freeze(["new", "invited", "declined", "archived"]);

/**
 * Check a submission without touching the network or the database.
 *
 * The same shape as the invitation form's validator, and deliberately so: the
 * two forms face the same open internet and the honeypot and timing checks
 * have already earned their place on the other one.
 */
export function validateInterest(body = {}, { now = () => Date.now(), editions = null } = {}) {
  // A real person never sees this field.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { ok: false, error: "Rejected." };
  }

  const started = Number(body.startedAt);
  if (Number.isFinite(started) && started > 0 && now() - started < MIN_FILL_MS) {
    return { ok: false, error: "Rejected." };
  }

  const text = (name) => String(body[name] ?? "").trim();

  if (!text("name")) return { ok: false, error: "Please enter your name." };
  if (!EMAIL.test(text("email"))) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (!text("company")) return { ok: false, error: "Please enter your company." };

  // A checkbox group arrives as one value or as many, depending on how many
  // were ticked, which is a classic way to end up storing the string "London"
  // as six single letters.
  const raw = body.editions ?? body.edition ?? [];
  const asked = (Array.isArray(raw) ? raw : [raw])
    .map((e) => String(e ?? "").trim())
    .filter(Boolean);

  if (!asked.length) return { ok: false, error: "Please select at least one edition." };

  // Only editions that exist. Whatever arrives has been through a browser, and
  // a list of places is about to be read by a person in an email.
  const known = editions ? asked.filter((e) => editions.includes(e)) : asked;
  if (!known.length) {
    return { ok: false, error: "Please select at least one edition." };
  }

  return {
    ok: true,
    data: {
      name: text("name").slice(0, MAX.name),
      email: text("email").toLowerCase().slice(0, MAX.email),
      company: text("company").slice(0, MAX.company),
      editions: [...new Set(known)].slice(0, 20),
      note: text("note").slice(0, MAX.note) || null,
      source: text("source").slice(0, MAX.source) || null
    }
  };
}

export function createInterest({ db }) {
  const present = (row) =>
    row
      ? {
          id: Number(row.id),
          name: row.name,
          email: row.email,
          company: row.company,
          editions: row.editions ?? [],
          note: row.note,
          source: row.source,
          status: row.status,
          handledBy: row.handled_by,
          handledAt: row.handled_at,
          createdAt: row.created_at
        }
      : null;

  return {
    async record({ name, email, company, editions, note = null, source = null }) {
      const { rows } = await db.query(
        `insert into the33_interest (name, email, company, editions, note, source)
         values ($1, $2, $3, $4, $5, $6)
         returning *`,
        [name, email, company, editions, note, source]
      );
      return present(rows[0]);
    },

    async list({ status = null, edition = null, limit = 200, offset = 0 } = {}) {
      const { rows } = await db.query(
        `select * from the33_interest
          where ($1::text is null or status = $1)
            and ($2::text is null or $2 = any (editions))
          order by created_at desc
          limit $3 offset $4`,
        [status, edition, Number(limit), Math.max(0, Number(offset) || 0)]
      );
      return rows.map(present);
    },

    /**
     * How many people want each edition.
     *
     * The only figure anybody will ask for: thirty-three seats, and this says
     * whether there are forty people who want Davos or four.
     */
    async demand() {
      const { rows } = await db.query(
        `select edition, count(*)::int as wanted
           from the33_interest, unnest(editions) as edition
          where status <> 'archived'
          group by edition
          order by wanted desc, edition`
      );
      return rows.map((r) => ({ edition: r.edition, wanted: r.wanted }));
    },

    async setStatus(id, status, by) {
      if (!STATUSES.includes(status)) throw new Error("That is not a status.");
      const { rows } = await db.query(
        `update the33_interest
            set status = $2, handled_by = $3, handled_at = now()
          where id = $1
         returning *`,
        [Number(id), status, by ?? null]
      );
      if (!rows.length) throw new Error("There is no such registration.");
      return present(rows[0]);
    },

    async count({ status = null } = {}) {
      const { rows } = await db.query(
        "select count(*)::int as n from the33_interest where ($1::text is null or status = $1)",
        [status]
      );
      return rows[0].n;
    }
  };
}
