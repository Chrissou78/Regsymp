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
