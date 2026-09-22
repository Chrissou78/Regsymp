/**
 * The events the site is about, one at a time.
 *
 * An event can be written months ahead and looked at before anybody else sees
 * it. Exactly one is live; the database enforces that with a partial unique
 * index rather than leaving it to whoever remembers, because "two events are
 * live" is a state with no sensible rendering.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FIELDS = [
  "name",
  "city",
  "country",
  "venue",
  "when_label",
  "starts_on",
  "ends_on",
  "series",
  "tagline",
  "summary",
  "upcoming",
  "sort"
];

const FROM_JS = {
  whenLabel: "when_label",
  startsOn: "starts_on",
  endsOn: "ends_on"
};

function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    slug: row.slug,
    name: row.name,
    city: row.city,
    country: row.country,
    venue: row.venue,
    whenLabel: row.when_label,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    series: row.series,
    tagline: row.tagline,
    summary: row.summary,
    status: row.status,
    upcoming: row.upcoming,
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** A date, an empty string, or something that is not a date at all. */
function asDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("A date should be written as 2027-01-19.");
  return text;
}

function assignments(fields, start) {
  const sets = [];
  const values = [];
  let i = start;
  for (const [key, value] of Object.entries(fields)) {
    const column = FROM_JS[key] ?? key;
    if (!FIELDS.includes(column)) continue;
    sets.push(`${column} = $${i++}`);
    values.push(
      column === "starts_on" || column === "ends_on"
        ? asDate(value)
        : column === "upcoming"
          ? Boolean(value)
          : column === "sort"
            ? Number(value) || 0
            : value === undefined || value === null || String(value).trim() === ""
              ? null
              : String(value).trim()
    );
  }
  return { sets, values, next: i };
}

export function createEvents({ db }) {
  return {
    async list() {
      const { rows } = await db.query(
        `select * from events
          order by case status when 'live' then 0 when 'draft' then 1 else 2 end,
                   sort, starts_on nulls last, name`
      );
      return rows.map(present);
    },

    async bySlug(slug) {
      const { rows } = await db.query("select * from events where slug = $1", [String(slug ?? "")]);
      return present(rows[0]);
    },

    /** The one the site is currently about, or nothing between events. */
    async live() {
      const { rows } = await db.query("select * from events where status = 'live'");
      return present(rows[0]);
    },

    /** What the "coming next" summary is built from. */
    async upcoming() {
      const { rows } = await db.query(
        `select * from events
          where upcoming and status <> 'past'
          order by sort, starts_on nulls last, name`
      );
      return rows.map(present);
    },

    async create(fields, createdBy) {
      const slug = String(fields.slug ?? "").trim().toLowerCase();
      if (!SLUG.test(slug)) {
        throw new Error("The identifier should be lowercase letters, digits and hyphens.");
      }
      if (!String(fields.name ?? "").trim()) throw new Error("Give the event a name.");
      if (!String(fields.whenLabel ?? fields.when_label ?? "").trim()) {
        throw new Error("Say when it is, even loosely — “Spring 2027” is an answer.");
      }

      const { sets, values } = assignments(fields, 3);
      const columns = sets.map((s) => s.split(" = ")[0]);

      const { rows } = await db
        .query(
          `insert into events (slug, created_by${columns.length ? ", " + columns.join(", ") : ""})
           values ($1, $2${values.map((_, i) => `, $${i + 3}`).join("")})
           returning *`,
          [slug, createdBy ?? null, ...values]
        )
        .catch((err) => {
          if (err.code === "23505") throw new Error(`There is already an event called ${slug}.`);
          throw err;
        });

      return present(rows[0]);
    },

    async update(slug, fields) {
      const { sets, values, next } = assignments(fields, 2);
      if (!sets.length) return this.bySlug(slug);

      const { rows } = await db.query(
        `update events set ${sets.join(", ")}, updated_at = now()
          where slug = $1
         returning *`,
        [String(slug), ...values]
      );
      void next;
      if (!rows.length) throw new Error("There is no such event.");
      return present(rows[0]);
    },

    /**
     * Make one event the one the site is about.
     *
     * In a transaction, and the previous one is stood down first: the unique
     * index would refuse the second live row, and refusing is the right answer
     * for a script that has got it wrong but a poor one for a person pressing
     * a button that means "this one now".
     */
    async activate(slug) {
      return db.tx(async (client) => {
        const found = await client.query("select status from events where slug = $1", [String(slug)]);
        if (!found.rows.length) throw new Error("There is no such event.");

        await client.query("update events set status = 'past', updated_at = now() where status = 'live'");
        const { rows } = await client.query(
          "update events set status = 'live', updated_at = now() where slug = $1 returning *",
          [String(slug)]
        );
        return present(rows[0]);
      });
    },

    /** Take the site back to having no event, without promoting another. */
    async standDown(slug) {
      const { rows } = await db.query(
        "update events set status = 'past', updated_at = now() where slug = $1 returning *",
        [String(slug)]
      );
      if (!rows.length) throw new Error("There is no such event.");
      return present(rows[0]);
    },

    async remove(slug) {
      const { rows } = await db.query(
        "delete from events where slug = $1 and status <> 'live' returning slug",
        [String(slug)]
      );
      if (!rows.length) {
        throw new Error("The live event cannot be removed. Make another one live first.");
      }
      return rows[0].slug;
    },

    /**
     * What the site is built from.
     *
     * Written to src/_data/events.json before every build, so the pages have
     * it the way they have any other content, and nothing in a template has to
     * know that a database exists.
     */
    async toData() {
      const [live, upcoming, all] = await Promise.all([this.live(), this.upcoming(), this.list()]);
      return {
        live,
        upcoming: upcoming.filter((e) => e.slug !== live?.slug),
        all
      };
    }
  };
}
