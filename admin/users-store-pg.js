import { hashPassword, verifyPassword } from "./password.js";

/**
 * Admin accounts in Postgres.
 *
 * Same interface as the document-backed store it replaces, so the routes did
 * not change. What did change is that there is no longer an environment
 * fallback: the owner account lives in the database like every other, because
 * a credential in a host dashboard is a credential nobody can rotate without
 * the host dashboard.
 *
 * The invite methods are gone. Nothing could create an invite any more, so
 * the redeem and revoke paths were unreachable code guarding a token.
 */

/** A hash to compare against when the account does not exist. */
const ABSENT = "scrypt$00$00";

export function createPgUserStore({ db, now = () => new Date() }) {
  /**
   * The owner is the account flagged as such, falling back to the earliest
   * created — the one that bootstrapped the admin. A partial unique index
   * makes two owners unrepresentable, so this cannot disagree with itself.
   */
  async function ownerRow() {
    const { rows } = await db.query(
      `select email from admin_users
        order by is_owner desc, created_at asc, email asc
        limit 1`
    );
    return rows[0] ?? null;
  }

  const key = (email) => String(email ?? "").trim().toLowerCase();

  return {
    async findHash(email) {
      const { rows } = await db.query(
        "select password_hash from admin_users where email = $1",
        [key(email)]
      );
      return rows[0]?.password_hash ?? null;
    },

    async verify(email, password) {
      const hash = await this.findHash(email);
      // Verify regardless of whether the account exists, so an unknown
      // address costs the same as a wrong password and the form cannot be
      // used to work out who has an account.
      const ok = await verifyPassword(password, hash ?? ABSENT);
      return ok && Boolean(hash);
    },

    async listUsers() {
      const { rows } = await db.query(
        `select email, is_owner, must_change_password, created_at, created_by
           from admin_users
          order by is_owner desc, created_at asc`
      );
      return rows.map((r) => ({
        email: r.email,
        owner: r.is_owner,
        mustChangePassword: r.must_change_password,
        createdAt: r.created_at,
        createdBy: r.created_by,
        source: "database"
      }));
    },

    async isOwner(email) {
      const address = key(email);
      if (!address) return false;
      const owner = await ownerRow();
      // With no accounts at all, whoever is signed in must be able to repair
      // things — though first-run means that state is normally unreachable.
      if (!owner) return true;
      return owner.email === address;
    },

    async ownerEmail() {
      return (await ownerRow())?.email ?? null;
    },

    async createUser(email, password, createdBy) {
      const address = key(email);
      if (!address.includes("@")) throw new Error("That does not look like an email address.");
      if (String(password ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }

      const hash = await hashPassword(password);

      return db.tx(async (client) => {
        const existing = await client.query("select 1 from admin_users where email = $1", [address]);
        if (existing.rows.length) throw new Error(`${address} already has an account.`);

        // The first account created owns the admin.
        const { rows } = await client.query("select count(*)::int as n from admin_users");
        const first = rows[0].n === 0;

        await client.query(
          `insert into admin_users
             (email, password_hash, is_owner, must_change_password, created_at, created_by)
           values ($1, $2, $3, true, $4, $5)`,
          [address, hash, first, now(), createdBy ?? null]
        );
        return address;
      });
    },

    /**
     * Change your own password. The current one is required, so a borrowed
     * session cannot be used to lock the real owner out.
     */
    async changePassword(email, currentPassword, newPassword) {
      const address = key(email);
      const hash = await this.findHash(address);
      if (!hash) throw new Error("That account no longer exists.");
      if (!(await verifyPassword(currentPassword, hash))) {
        throw new Error("Your current password is not correct.");
      }
      if (String(newPassword ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }
      if (await verifyPassword(newPassword, hash)) {
        throw new Error("That is the same as your current password.");
      }

      await db.query(
        `update admin_users
            set password_hash = $2,
                password_changed_at = $3,
                must_change_password = false
          where email = $1`,
        [address, await hashPassword(newPassword), now()]
      );
    },

    async removeUser(email, removedBy) {
      const address = key(email);
      return db.tx(async (client) => {
        const { rows } = await client.query(
          "select is_owner from admin_users where email = $1",
          [address]
        );
        if (!rows.length) throw new Error("There is no such account.");
        if (rows[0].is_owner) {
          throw new Error("That is the owner account; it cannot be removed.");
        }
        const count = await client.query("select count(*)::int as n from admin_users");
        if (count.rows[0].n <= 1) {
          throw new Error("That is the only remaining admin; add another before removing this one.");
        }
        await client.query("delete from admin_users where email = $1", [address]);
      });
    }
  };
}
