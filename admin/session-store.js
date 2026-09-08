import { randomBytes } from "node:crypto";

/**
 * Sessions in Postgres.
 *
 * Same shape as the in-memory store it replaces, except the reads are async:
 * a session has to survive a restart. It did not before, and the consequence
 * was visible rather than theoretical — the navigation showed an "Admin" link
 * from a cookie that outlived the server, so after every deploy the menu said
 * you were signed in and the first click bounced you to sign in again.
 *
 * `kind` keeps the two populations apart in one table, so signing out of the
 * portal cannot reach an admin session and vice versa.
 */

const EIGHT_HOURS = 8 * 60 * 60 * 1000;

export function createPgSessions({ db, kind, ttlMs = EIGHT_HOURS, now = () => Date.now() }) {
  if (!["admin", "guest"].includes(kind)) throw new Error("kind must be admin or guest");

  /** Expired rows are dead weight; clear them opportunistically. */
  let lastSweep = 0;
  async function sweep() {
    if (now() - lastSweep < 60_000) return;
    lastSweep = now();
    await db.query("delete from sessions where expires_at <= now()").catch(() => {});
  }

  return {
    async create(user, token) {
      const id = randomBytes(24).toString("hex");
      await db.query(
        `insert into sessions (id, kind, subject, expires_at)
         values ($1, $2, $3, $4)`,
        [id, kind, JSON.stringify({ user, token: token ?? null }), new Date(now() + ttlMs)]
      );
      void sweep();
      return id;
    },

    async get(id) {
      if (!id) return undefined;
      const { rows } = await db.query(
        `select subject, expires_at from sessions
          where id = $1 and kind = $2 and expires_at > now()`,
        [String(id), kind]
      );
      if (!rows.length) return undefined;
      return {
        user: rows[0].subject.user,
        token: rows[0].subject.token,
        expires: new Date(rows[0].expires_at).getTime()
      };
    },

    async destroy(id) {
      if (!id) return;
      await db.query("delete from sessions where id = $1 and kind = $2", [String(id), kind]);
    },

    /**
     * Sign out every other session for an address.
     * Used after a password change: if it was changed because it leaked,
     * leaving the other sessions alive defeats the point.
     */
    async destroyOthersFor(email, keepId) {
      const { rowCount } = await db.query(
        `delete from sessions
          where kind = $1
            and lower(subject -> 'user' ->> 'email') = lower($2)
            and id <> $3`,
        [kind, String(email ?? ""), String(keepId ?? "")]
      );
      return rowCount ?? 0;
    },

    async size() {
      const { rows } = await db.query(
        "select count(*)::int as n from sessions where kind = $1 and expires_at > now()",
        [kind]
      );
      return rows[0].n;
    }
  };
}
