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
 * Number ranges live in badge_categories now, so the organisers can add and
 * remove categories without a migration. A trigger on tickets still refuses a
 * number outside its category's range, so the rule survived becoming data.
 */

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
                t.category as ticket_category,
                t.code as ticket_code,
                c.label as ticket_label,
                c.colour as ticket_colour,
                t.revoked_at as ticket_revoked_at,
                t.claimed_at as ticket_claimed_at
           from attendees a
           left join tickets t on t.attendee_id = a.id and t.revoked_at is null
           left join badge_categories c on c.slug = t.category
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
        ticket: r.ticket_category
          ? {
              number: r.ticket_number,
              category: r.ticket_category,
              label: r.ticket_label,
              colour: r.ticket_colour,
              code: r.ticket_code,
              claimedAt: r.ticket_claimed_at
            }
          : null
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
     * Issue the lowest free number in the category.
     *
     * Chosen in one statement so two simultaneous registrations cannot pick
     * the same number; if they somehow do, the unique index rejects one and
     * the retry takes the next. Counting rows and adding one would race.
     */
    async issueTicket({ attendeeId, category, issuedBy, areas = [], number = null }) {
      // A number asked for by name rather than taken from the top of the pool.
      // Freeing VIP 7 is only half of "give 7 to somebody else": without this
      // the allocator would hand out the lowest free number, which may not be
      // the one just released.
      const wanted =
        number === null || number === undefined || String(number).trim() === ""
          ? null
          : Number(number);
      if (wanted !== null && !Number.isInteger(wanted)) {
        throw new Error("A badge number has to be a whole number.");
      }

      const found = await db.query(
        "select slug, label, number_from, number_to from badge_categories where slug = $1",
        [String(category ?? "")]
      );
      if (!found.rows.length) throw new Error("Choose a badge category.");
      const range = found.rows[0];
      const numbered = range.number_from !== null;

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await db.tx(async (client) => {
            const existing = await client.query(
              "select 1 from tickets where attendee_id = $1 and revoked_at is null",
              [Number(attendeeId)]
            );
            if (existing.rows.length) throw new Error("That attendee already holds a badge.");

            // An address that signed itself up has to prove itself first. One
            // an admin typed is vouched for by a person, so it need not wait.
            const who = await client.query(
              "select self_registered, email_verified_at, email from attendees where id = $1",
              [Number(attendeeId)]
            );
            if (!who.rows.length) throw new Error("There is no such attendee.");
            if (who.rows[0].self_registered && !who.rows[0].email_verified_at) {
              throw new Error(`${who.rows[0].email} has not confirmed their email address yet.`);
            }

            const code = randomBytes(24).toString("base64url");
            let rows;

            if (wanted !== null) {
              if (!numbered) {
                throw new Error(`${range.label} badges do not carry numbers.`);
              }
              // Said plainly here rather than left to the unique index, whose
              // message names an index instead of the problem.
              const held = await client.query(
                "select 1 from tickets where number = $1 and released_at is null",
                [wanted]
              );
              if (held.rows.length) {
                throw new Error(
                  `Number ${wanted} is already held. Withdraw that badge and free ` +
                    "its number first, or leave the number blank to take the next one."
                );
              }
              ({ rows } = await client.query(
                `insert into tickets (attendee_id, number, category, code, issued_by)
                 values ($1, $2, $3, $4, $5)
                 returning *`,
                [Number(attendeeId), wanted, range.slug, code, issuedBy ?? null]
              ));
            } else if (numbered) {
              // The lowest free number in the range, chosen in one statement
              // so two simultaneous issues cannot pick the same one.
              ({ rows } = await client.query(
                `insert into tickets (attendee_id, number, category, code, issued_by)
                 select $1, n, $2, $3, $4
                   from generate_series($5::int, $6::int) as n
                  where not exists (
                          select 1 from tickets t
                           where t.number = n and t.released_at is null
                        )
                  order by n
                  limit 1
                 returning *`,
                [
                  Number(attendeeId),
                  range.slug,
                  code,
                  issuedBy ?? null,
                  range.number_from,
                  range.number_to
                ]
              ));
              if (!rows.length) {
                throw new Error(
                  `No ${range.label} badges left — ${range.number_to - range.number_from + 1} is the limit.`
                );
              }
            } else {
              // Unnumbered, which is how speakers start: a badge that says
              // what they are rather than where they sit in a sequence.
              ({ rows } = await client.query(
                `insert into tickets (attendee_id, number, category, code, issued_by)
                 values ($1, null, $2, $3, $4)
                 returning *`,
                [Number(attendeeId), range.slug, code, issuedBy ?? null]
              ));
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
          const raced =
            (err.code === "23505" || /tickets_number_(key|held)/.test(err.message ?? "")) &&
            wanted === null;
          if (!raced || attempt === 4) throw err;
        }
      }
      throw new Error("Could not allocate a badge number.");
    },

    async ticketFor(attendeeId) {
      const { rows } = await db.query(
        `select t.*, c.label as category_label, c.colour, c.number_to,
                coalesce(array_agg(a.area) filter (where a.area is not null), '{}') as areas
           from tickets t
           join badge_categories c on c.slug = t.category
           left join ticket_access a on a.ticket_id = t.id
          where t.attendee_id = $1 and t.revoked_at is null
          group by t.id, c.label, c.colour, c.number_to`,
        [Number(attendeeId)]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: Number(row.id),
        number: row.number,
        category: row.category,
        categoryLabel: row.category_label,
        colour: row.colour,
        code: row.code,
        // An unnumbered badge says what it is instead of where it sits.
        label: row.number === null ? row.category_label : `${row.number}/${row.number_to}`,
        areas: row.areas,
        issuedAt: row.issued_at,
        claimedAt: row.claimed_at,
        walletSerial: row.wallet_serial,
        walletUrl: row.wallet_url,
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
        `select t.*, c.label as category_label, c.colour, c.number_to,
                coalesce(array_agg(x.area) filter (where x.area is not null), '{}') as areas,
                a.id as a_id, a.email, a.first_name, a.last_name, a.company, a.role
           from tickets t
           join attendees a on a.id = t.attendee_id
           join badge_categories c on c.slug = t.category
           left join ticket_access x on x.ticket_id = t.id
          where t.code = $1 and t.revoked_at is null
          group by t.id, a.id, c.label, c.colour, c.number_to`,
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
          category: row.category,
          categoryLabel: row.category_label,
          colour: row.colour,
          label: row.number === null ? row.category_label : `${row.number}/${row.number_to}`,
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

    /**
     * Accept a badge. This is the attendee's own act, in their portal.
     *
     * It is also the moment the badge stops being editable. Up to here the
     * organisers can cancel it and give the number to somebody else; from here
     * the person is holding it -- on a phone, in a wallet, or printed -- so
     * nothing about it may change and its number can never be reused.
     */
    async claimTicket(ticketId) {
      const { rows } = await db.query(
        `update tickets
            set claimed_at = coalesce(claimed_at, now())
          where id = $1 and revoked_at is null
         returning *`,
        [Number(ticketId)]
      );
      if (!rows.length) throw new Error("That badge is no longer valid.");
      return rows[0];
    },

    /**
     * Remember the wallet pass made for a badge.
     *
     * So that pressing "add to my wallet" again -- on a second phone, or after
     * clearing the wallet -- hands back the same pass instead of minting a new
     * one. Two passes for one badge number is two things to keep updated, and
     * one of them will be missed.
     */
    async recordWalletPass(ticketId, { serial, url }) {
      const { rows } = await db.query(
        `update tickets
            set wallet_serial = $2, wallet_url = $3, wallet_made_at = now()
          where id = $1
         returning wallet_serial, wallet_url`,
        [Number(ticketId), String(serial), String(url)]
      );
      return rows[0] ?? null;
    },

    /**
     * Withdraw a badge, optionally putting its number back into the pool.
     *
     * Releasing is refused once the badge has been claimed, and the same rule
     * is a check constraint on the table. Two people carrying VIP 7 is the one
     * failure that cannot be sorted out at the door, so it is worth stating
     * twice.
     */
    async revokeTicket(ticketId, { release = false } = {}) {
      if (release) {
        const { rows } = await db.query(
          "select number, claimed_at from tickets where id = $1",
          [Number(ticketId)]
        );
        if (!rows.length) throw new Error("There is no such badge.");
        if (rows[0].claimed_at) {
          throw new Error(
            `Number ${rows[0].number} cannot be reused: this badge has been claimed, ` +
              "so its holder already has it. Withdraw it instead, and the number " +
              "retires with it."
          );
        }
      }

      const { rows } = await db.query(
        `update tickets
            set revoked_at  = coalesce(revoked_at, now()),
                released_at = case when $2 then coalesce(released_at, now()) else released_at end
          where id = $1
         returning number, category, revoked_at, released_at, claimed_at`,
        [Number(ticketId), Boolean(release)]
      );
      return rows[0] ?? null;
    },

    /** Put an unclaimed badge's number back into the pool. */
    async releaseNumber(ticketId) {
      return this.revokeTicket(ticketId, { release: true });
    },

    /** How full the event is, per badge category. */
    async capacity() {
      const { rows } = await db.query(
        `select c.slug, c.label, c.number_from, c.number_to, c.colour, c.sort,
                (select count(*)::int from tickets t
                  where t.category = c.slug and t.revoked_at is null) as issued
           from badge_categories c
          order by c.sort, c.label`
      );
      return rows.map((r) => ({
        category: r.slug,
        label: r.label,
        colour: r.colour,
        issued: r.issued,
        from: r.number_from,
        to: r.number_to,
        numbered: r.number_from !== null,
        limit: r.number_from === null ? null : r.number_to - r.number_from + 1
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
