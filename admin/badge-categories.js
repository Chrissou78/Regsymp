/**
 * Badge categories.
 *
 * Speaker, VIP and Visitor to begin with, but the organisers can add and
 * remove them — Press, Staff, Sponsor — without a migration. Each carries an
 * optional number range, which is what makes capacity a property of the
 * category rather than something written into SQL.
 *
 * The range rule itself is enforced by a trigger on tickets, so nothing here
 * is load-bearing for correctness. What lives here is what a database
 * constraint cannot express: that two categories drawing from overlapping
 * numbers is a mistake rather than a policy.
 */

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;

/** A colour the badge stylesheet can use, or nothing. */
function normaliseColour(value) {
  const text = String(value ?? "").trim();
  if (!text) return "#1C2B4A";
  const hex = text.startsWith("#") ? text : `#${text}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error("Use a colour like #1C2B4A.");
  return hex.toUpperCase();
}

function readRange(from, to) {
  const blank = (v) => v === null || v === undefined || String(v).trim() === "";
  if (blank(from) && blank(to)) return { from: null, to: null };
  if (blank(from) || blank(to)) {
    throw new Error("A numbered category needs both a first and a last number.");
  }

  const start = Number(from);
  const end = Number(to);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1) {
    throw new Error("Numbers must be whole and start at 1 or more.");
  }
  if (start > end) throw new Error("The first number must not be after the last.");
  return { from: start, to: end };
}

export function createBadgeCategories({ db }) {
  /**
   * Two categories drawing from the same numbers is almost always a slip, and
   * the symptom would be a baffling "no numbers left" much later. The unique
   * index would stop an actual collision; this stops the confusion.
   */
  async function assertNoOverlap(slug, range) {
    if (range.from === null) return;
    const { rows } = await db.query(
      `select slug, label, number_from, number_to
         from badge_categories
        where slug <> $1
          and number_from is not null
          and number_from <= $3
          and number_to   >= $2`,
      [slug, range.from, range.to]
    );
    if (rows.length) {
      const clash = rows[0];
      throw new Error(
        `Those numbers overlap ${clash.label} (${clash.number_from}–${clash.number_to}). ` +
          `Give each category its own range.`
      );
    }
  }

  return {
    async list() {
      const { rows } = await db.query(
        `select c.*,
                (select count(*)::int from tickets t
                  where t.category = c.slug and t.revoked_at is null) as issued
           from badge_categories c
          order by c.sort, c.label`
      );
      return rows.map((r) => ({
        slug: r.slug,
        label: r.label,
        from: r.number_from,
        to: r.number_to,
        numbered: r.number_from !== null,
        limit: r.number_from === null ? null : r.number_to - r.number_from + 1,
        issued: r.issued,
        colour: r.colour,
        sort: r.sort,
        protected: r.protected
      }));
    },

    async byslug(slug) {
      return (await this.list()).find((c) => c.slug === slug) ?? null;
    },

    async create({ slug, label, from, to, colour, sort }) {
      const key = String(slug ?? "").trim().toLowerCase();
      if (!SLUG.test(key)) {
        throw new Error("The identifier should be lowercase letters, digits and hyphens.");
      }
      if (!String(label ?? "").trim()) throw new Error("Give the category a label.");

      const range = readRange(from, to);
      await assertNoOverlap(key, range);

      try {
        await db.query(
          `insert into badge_categories (slug, label, number_from, number_to, colour, sort)
           values ($1, $2, $3, $4, $5, $6)`,
          [key, String(label).trim(), range.from, range.to, normaliseColour(colour), Number(sort) || 0]
        );
      } catch (err) {
        if (err.code === "23505") throw new Error(`There is already a category called ${key}.`);
        throw err;
      }
      return this.byslug(key);
    },

    async update(slug, { label, from, to, colour, sort }) {
      const existing = await this.byslug(slug);
      if (!existing) throw new Error("There is no such category.");

      const range = readRange(from, to);
      await assertNoOverlap(slug, range);

      // Shrinking a range under tickets already issued would leave rows the
      // trigger now considers invalid, and nothing would say so until the
      // next edit failed.
      if (range.from !== null) {
        const { rows } = await db.query(
          `select count(*)::int as stranded from tickets
            where category = $1 and revoked_at is null
              and (number is null or number < $2 or number > $3)`,
          [slug, range.from, range.to]
        );
        if (rows[0].stranded) {
          throw new Error(
            `${rows[0].stranded} ticket(s) already issued in ${existing.label} fall outside ` +
              `${range.from}–${range.to}. Withdraw them first, or widen the range.`
          );
        }
      } else {
        const { rows } = await db.query(
          `select count(*)::int as numbered from tickets
            where category = $1 and revoked_at is null and number is not null`,
          [slug]
        );
        if (rows[0].numbered) {
          throw new Error(
            `${rows[0].numbered} ticket(s) in ${existing.label} carry numbers, so it cannot ` +
              `become unnumbered. Withdraw them first.`
          );
        }
      }

      await db.query(
        `update badge_categories
            set label = $2, number_from = $3, number_to = $4, colour = $5, sort = $6
          where slug = $1`,
        [
          slug,
          String(label ?? existing.label).trim(),
          range.from,
          range.to,
          normaliseColour(colour ?? existing.colour),
          Number(sort ?? existing.sort) || 0
        ]
      );
      return this.byslug(slug);
    },

    async remove(slug) {
      const existing = await this.byslug(slug);
      if (!existing) throw new Error("There is no such category.");
      if (existing.protected) {
        throw new Error(
          `${existing.label} is one of the three the event is built around and cannot be removed. ` +
            `You can rename it or change its numbers.`
        );
      }
      // Count withdrawn badges too. They still reference the category, so the
      // foreign key would refuse the delete anyway -- better to say why than
      // to surface a constraint name.
      const { rows } = await db.query(
        "select count(*)::int as total from tickets where category = $1",
        [slug]
      );
      if (rows[0].total) {
        throw new Error(
          `${rows[0].total} badge(s) have been issued in ${existing.label}, including any ` +
            `withdrawn. A category cannot be removed once it has been used.`
        );
      }
      await db.query("delete from badge_categories where slug = $1", [slug]);
    }
  };
}
