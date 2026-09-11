/**
 * One address is one person, so one address has one password.
 *
 * Administrators and attendees live in separate tables for good reasons: an
 * attendee has a badge and a profile, an administrator has neither, and most
 * of each population is not in the other. But some people are both -- a
 * speaker who also runs the site -- and for them two tables meant two
 * passwords, which meant signing in with one of them and being told, in
 * effect, that they were somebody else.
 *
 * So whenever a password is set on either side, it is written to the other if
 * that address exists there. The hash is copied rather than recomputed: the
 * two stores must not drift into disagreeing about the same person, and
 * hashing twice would produce different salts for what is one credential.
 */

/** Copy a freshly written hash to the other table, if the address is in it. */
export async function mirrorPassword(db, { email, hash, to }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address || !hash) return false;

  const sql =
    to === "admin"
      ? `update admin_users
            set password_hash = $2, password_changed_at = now(), must_change_password = false
          where email = $1`
      : `update attendees
            set password_hash = $2, claimed_at = coalesce(claimed_at, now())
          where email = $1`;

  const { rowCount } = await db.query(sql, [address, hash]);
  return rowCount > 0;
}

/** The password an attendee already has, so promoting them keeps it. */
export async function attendeeHash(db, email) {
  const { rows } = await db.query(
    "select password_hash from attendees where email = $1 and password_hash is not null",
    [String(email ?? "").trim().toLowerCase()]
  );
  return rows[0]?.password_hash ?? null;
}

/**
 * Give an administrator a profile, if they have not got one.
 *
 * Promotion starts from the guest list, so it is only the accounts created
 * before anybody was on it -- the first one, in particular -- that can reach
 * this. Their password comes with them: one address, one credential.
 *
 * No badge: being an administrator is not being a guest, and which badge they
 * should carry, if any, is a decision for the guest list.
 */
export async function ensureProfile(db, { email, hash = null, createdBy = null }) {
  const address = String(email ?? "").trim().toLowerCase();
  if (!address) return false;

  const { rowCount } = await db.query(
    `insert into attendees (email, category, password_hash, claimed_at, self_registered, created_by)
     select $1, 'visitor', $2, case when $2::text is not null then now() end, false, $3
      where not exists (select 1 from attendees where email = $1)`,
    [address, hash, createdBy]
  );
  return rowCount > 0;
}
