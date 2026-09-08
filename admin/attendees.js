import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * Attendees and their tickets.
 *
 * Kept apart from admin accounts on purpose: different population, different
 * fields, different sign-in surface. An attendee should never be one
 * accidental join away from the content editor's privileges.
 *
 * Accounts are created by an admin and claimed by email, because the event is
 * invitation-only with a hard cap. Nobody signs themselves up.
 */

/**
 * One sequence of numbers across the event: 1-33 VIP, 34-100 general.
 *
 * Duplicated in a database constraint, deliberately. This copy allocates the
 * next free number; that copy makes the rule impossible to break, including
 * by a future caller that forgets it exists.
 */
export const TIERS = Object.freeze({
  vip: { from: 1, to: 33 },
  general: { from: 34, to: 100 }
});

export const CAPACITY = TIERS.general.to;

const TOKEN_TTL = {
  claim: 30 * 24 * 60 * 60 * 1000,
  reset: 60 * 60 * 1000,
  verify: 7 * 24 * 60 * 60 * 1000
};

/** A hash to compare against when the account does not exist. */
const ABSENT = "scrypt$00$00";

const key = (email) => String(email ?? "").trim().toLowerCase();

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function digestsMatch(a, b) {
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The shape handed to templates. Never includes the password hash. */
function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    role: row.role,
    firstName: row.first_name,
    lastName: row.last_name,
    name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
    birthDate: row.birth_date,
    country: row.country,
    company: row.company,
    position: row.position,
    socials: row.socials ?? {},
    description: row.description,
    photoPath: row.photo_path,
    consentMarketing: row.consent_marketing,
    consentAt: row.consent_at,
    createdAt: row.created_at,
    createdBy: row.created_by,
    claimedAt: row.claimed_at,
    lastLoginAt: row.last_login_at,
    claimed: Boolean(row.password_hash),
    emailVerified: Boolean(row.email_verified_at),
    emailVerifiedAt: row.email_verified_at,
    selfRegistered: row.self_registered,
    speakerSlug: row.speaker_slug,
    notes: row.notes
  };
}

const WRITABLE = {
  firstName: "first_name",
  lastName: "last_name",
  birthDate: "birth_date",
  country: "country",
  company: "company",
  position: "position",
  socials: "socials",
  description: "description",
  photoPath: "photo_path",
  role: "role",
  notes: "notes",
  consentMarketing: "consent_marketing",
  speakerSlug: "speaker_slug"
};

export function createAttendees({ db, now = () => new Date() }) {
  /** Turn a field object into a parameterised SET clause. */
  function assignments(fields, start = 1) {
    const sets = [];
    const values = [];
    let i = start;
    for (const [name, column] of Object.entries(WRITABLE)) {
      if (!(name in fields)) continue;
      let value = fields[name];
      if (name === "socials") value = JSON.stringify(value ?? {});
      if (name === "birthDate" && !value) value = null;
      sets.push(`${column} = $${i++}`);
      values.push(value);
    }
    return { sets, values, next: i };
  }

  return {
    async create(fields, createdBy) {
      const email = key(fields.email);
      if (!email.includes("@")) throw new Error("That does not look like an email address.");
      if (!["visitor", "speaker"].includes(fields.role ?? "visitor")) {
        throw new Error("Role must be visitor or speaker.");
      }

      const { sets, values, next } = assignments(fields, 3);
      const { rows } = await db
        .query(
          `insert into attendees (email, created_by${sets.length ? ", " + Object.entries(WRITABLE).filter(([n]) => n in fields).map(([, c]) => c).join(", ") : ""})
           values ($1, $2${sets.length ? ", " + values.map((_, i) => `$${i + 3}`).join(", ") : ""})
           returning *`,
          [email, createdBy ?? null, ...values]
        )
        .catch((err) => {
          if (err.code === "23505" || /unique/i.test(err.message)) {
            throw new Error(`${email} is already registered.`);
          }
          throw err;
        });
      void next;
      return present(rows[0]);
    },

    /**
     * Somebody signing themselves up.
     *
     * An account on its own grants nothing: it is identity, not admission.
     * A ticket is issued separately by an admin, which is what keeps the
     * guest list a whitelist rather than a race for the first hundred.
     */
    async register({ email, password, firstName = null, lastName = null, company = null }) {
      const address = key(email);
      if (!address.includes("@") || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(address)) {
        throw new Error("Please enter a valid email address.");
      }
      if (String(password ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }

      const hash = await hashPassword(password);
      try {
        const { rows } = await db.query(
          `insert into attendees
             (email, password_hash, first_name, last_name, company,
              self_registered, claimed_at)
           values ($1, $2, $3, $4, $5, true, $6)
           returning *`,
          [address, hash, firstName, lastName, company, now()]
        );
        return present(rows[0]);
      } catch (err) {
        if (err.code === "23505") {
          // Deliberately the same wording the sign-in page would give, so
          // the form cannot be used to discover who already has an account.
          const clash = new Error("That address already has an account.");
          clash.code = "DUPLICATE";
          throw clash;
        }
        throw err;
      }
    },

    /** Mark an address as proven, from a verification link. */
    async verifyEmail(token) {
      const found = await this.findToken(token, "verify");
      if (!found) throw new Error("That link is invalid, already used, or expired.");

      await db.tx(async (client) => {
        await client.query(
          "update attendees set email_verified_at = coalesce(email_verified_at, $2) where id = $1",
          [found.attendeeId, now()]
        );
        await client.query("update attendee_tokens set used_at = $2 where token_hash = $1", [
          hashToken(token),
          now()
        ]);
      });
      return found;
    },

    async list({ role = null, q = null, limit = 200 } = {}) {
      const { rows } = await db.query(
        `select a.*,
                t.number as ticket_number,
                t.tier   as ticket_tier,
                t.revoked_at as ticket_revoked_at
           from attendees a
           left join tickets t on t.attendee_id = a.id and t.revoked_at is null
          where ($1::text is null or a.role = $1)
            and ($2::text is null or
                 a.email ilike '%' || $2 || '%' or
                 coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'') ilike '%' || $2 || '%' or
                 coalesce(a.company,'') ilike '%' || $2 || '%')
          order by t.number nulls last, a.created_at
          limit $3`,
        [role, q, limit]
      );
      return rows.map((r) => ({
        ...present(r),
        ticket: r.ticket_number ? { number: r.ticket_number, tier: r.ticket_tier } : null
      }));
    },

    async byId(id) {
      const { rows } = await db.query("select * from attendees where id = $1", [Number(id)]);
      return present(rows[0]);
    },

    async byEmail(email) {
      const { rows } = await db.query("select * from attendees where email = $1", [key(email)]);
      return present(rows[0]);
    },

    async update(id, fields) {
      const { sets, values } = assignments(fields, 2);
      if (!sets.length) return this.byId(id);
      const { rows } = await db.query(
        `update attendees set ${sets.join(", ")} where id = $1 returning *`,
        [Number(id), ...values]
      );
      return present(rows[0]);
    },

    async remove(id) {
      await db.query("delete from attendees where id = $1", [Number(id)]);
    },

    // ------------------------------------------------------------- tickets

    /**
     * Issue the lowest free number in the tier.
     *
     * Chosen in one statement so two simultaneous registrations cannot pick
     * the same number; if they somehow do, the unique index rejects one and
     * the retry takes the next. Counting rows and adding one would race.
     */
    async issueTicket({ attendeeId, tier, issuedBy, areas = [] }) {
      const range = TIERS[tier];
      if (!range) throw new Error("Tier must be vip or general.");

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await db.tx(async (client) => {
            const existing = await client.query(
              "select 1 from tickets where attendee_id = $1 and revoked_at is null",
              [Number(attendeeId)]
            );
            if (existing.rows.length) throw new Error("That attendee already holds a ticket.");

            // An address that signed itself up has to prove itself first.
            // One an admin typed is already vouched for by a person, so it
            // does not need to wait for a click.
            const who = await client.query(
              "select self_registered, email_verified_at, email from attendees where id = $1",
              [Number(attendeeId)]
            );
            if (!who.rows.length) throw new Error("There is no such attendee.");
            if (who.rows[0].self_registered && !who.rows[0].email_verified_at) {
              throw new Error(
                `${who.rows[0].email} has not confirmed their email address yet.`
              );
            }

            const { rows } = await client.query(
              `insert into tickets (attendee_id, number, tier, code, issued_by)
               select $1, n, $2, $3, $4
                 -- Cast explicitly: an untyped parameter leaves Postgres
                 -- unable to choose between the generate_series overloads.
                 from generate_series($5::int, $6::int) as n
                where not exists (select 1 from tickets t where t.number = n)
                order by n
                limit 1
               returning *`,
              [
                Number(attendeeId),
                tier,
                randomBytes(24).toString("base64url"),
                issuedBy ?? null,
                range.from,
                range.to
              ]
            );
            if (!rows.length) {
              throw new Error(
                `No ${tier} tickets left — ${range.to - range.from + 1} is the limit.`
              );
            }

            for (const area of areas) {
              await client.query(
                "insert into ticket_access (ticket_id, area) values ($1, $2) on conflict do nothing",
                [rows[0].id, area]
              );
            }
            return rows[0];
          });
        } catch (err) {
          const raced = err.code === "23505" || /tickets_number_key/.test(err.message ?? "");
          if (!raced || attempt === 4) throw err;
        }
      }
      throw new Error("Could not allocate a ticket number.");
    },

    async ticketFor(attendeeId) {
      const { rows } = await db.query(
        `select t.*, coalesce(array_agg(a.area) filter (where a.area is not null), '{}') as areas
           from tickets t
           left join ticket_access a on a.ticket_id = t.id
          where t.attendee_id = $1 and t.revoked_at is null
          group by t.id`,
        [Number(attendeeId)]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        number: row.number,
        tier: row.tier,
        code: row.code,
        label: `${row.number}/${TIERS[row.tier].to}`,
        areas: row.areas,
        issuedAt: row.issued_at,
        checkedInAt: row.checked_in_at
      };
    },

    /**
     * Look a ticket up by the code in its QR.
     *
     * The code is the credential, so a valid one identifies its holder and an
     * invalid one reveals nothing at all.
     */
    async byTicketCode(code) {
      if (!code || String(code).length < 16) return null;
      const { rows } = await db.query(
        `select t.*, coalesce(array_agg(x.area) filter (where x.area is not null), '{}') as areas,
                a.id as a_id, a.email, a.first_name, a.last_name, a.company, a.role
           from tickets t
           join attendees a on a.id = t.attendee_id
           left join ticket_access x on x.ticket_id = t.id
          where t.code = $1 and t.revoked_at is null
          group by t.id, a.id`,
        [String(code)]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        guest: {
          id: Number(row.a_id),
          email: row.email,
          name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
          company: row.company,
          role: row.role
        },
        ticket: {
          id: Number(row.id),
          number: row.number,
          tier: row.tier,
          label: `${row.number}/${TIERS[row.tier].to}`,
          areas: row.areas,
          checkedInAt: row.checked_in_at
        }
      };
    },

    async checkIn(ticketId) {
      const { rows } = await db.query(
        `update tickets set checked_in_at = coalesce(checked_in_at, now())
          where id = $1 and revoked_at is null
         returning checked_in_at`,
        [Number(ticketId)]
      );
      return rows[0]?.checked_in_at ?? null;
    },

    async revokeTicket(ticketId) {
      await db.query("update tickets set revoked_at = now() where id = $1", [Number(ticketId)]);
    },

    /** How full the event is, per tier. */
    async capacity() {
      const { rows } = await db.query(
        `select tier, count(*)::int as issued
           from tickets where revoked_at is null group by tier`
      );
      const issued = Object.fromEntries(rows.map((r) => [r.tier, r.issued]));
      return Object.entries(TIERS).map(([tier, range]) => ({
        tier,
        issued: issued[tier] ?? 0,
        limit: range.to - range.from + 1,
        from: range.from,
        to: range.to
      }));
    },

    // ---------------------------------------------------------------- auth

    async verify(email, password) {
      const { rows } = await db.query("select password_hash from attendees where email = $1", [
        key(email)
      ]);
      const hash = rows[0]?.password_hash;
      // Run the derivation either way, so an unknown address costs the same
      // as a wrong password and the form cannot be used to enumerate guests.
      const ok = await verifyPassword(password, hash ?? ABSENT);
      return ok && Boolean(hash);
    },

    async setPassword(attendeeId, password) {
      if (String(password ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }
      await db.query(
        `update attendees
            set password_hash = $2,
                claimed_at = coalesce(claimed_at, $3)
          where id = $1`,
        [Number(attendeeId), await hashPassword(password), now()]
      );
    },

    async recordLogin(attendeeId) {
      await db.query("update attendees set last_login_at = $2 where id = $1", [
        Number(attendeeId),
        now()
      ]);
    },

    /** Issue a one-time link. Returns the raw token, which is never stored. */
    async createToken(attendeeId, purpose) {
      if (!TOKEN_TTL[purpose]) throw new Error("Unknown token purpose.");
      const token = randomBytes(32).toString("base64url");

      await db.tx(async (client) => {
        // One live token per purpose: a new link should invalidate the last.
        await client.query("delete from attendee_tokens where attendee_id = $1 and purpose = $2", [
          Number(attendeeId),
          purpose
        ]);
        await client.query(
          `insert into attendee_tokens (token_hash, attendee_id, purpose, expires_at)
           values ($1, $2, $3, $4)`,
          [hashToken(token), Number(attendeeId), purpose, new Date(now().getTime() + TOKEN_TTL[purpose])]
        );
      });
      return token;
    },

    /** Look a token up without consuming it, for rendering the form. */
    async findToken(token, purpose) {
      if (!token) return null;
      const digest = hashToken(token);
      const { rows } = await db.query(
        `select t.token_hash, t.attendee_id, a.email
           from attendee_tokens t
           join attendees a on a.id = t.attendee_id
          where t.purpose = $1 and t.used_at is null and t.expires_at > $2`,
        [purpose, now()]
      );
      const match = rows.find((r) => digestsMatch(r.token_hash, digest));
      return match ? { attendeeId: Number(match.attendee_id), email: match.email } : null;
    },

    /** Consume a token and set the password in one transaction. */
    async redeemToken(token, purpose, password) {
      const found = await this.findToken(token, purpose);
      if (!found) throw new Error("That link is invalid, already used, or expired.");
      if (String(password ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }

      const hash = await hashPassword(password);
      await db.tx(async (client) => {
        await client.query(
          `update attendees
              set password_hash = $2, claimed_at = coalesce(claimed_at, $3)
            where id = $1`,
          [found.attendeeId, hash, now()]
        );
        await client.query("update attendee_tokens set used_at = $2 where token_hash = $1", [
          hashToken(token),
          now()
        ]);
      });
      return found;
    },

    async recordConsent(attendeeId, granted) {
      await db.query(
        "update attendees set consent_marketing = $2, consent_at = $3 where id = $1",
        [Number(attendeeId), Boolean(granted), granted ? now() : null]
      );
    }
  };
}
