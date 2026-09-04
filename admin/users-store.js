import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword, parseUsers } from "./password.js";

/**
 * Admin accounts, stored in the content repository rather than the
 * environment.
 *
 * The point is that nobody needs server access to add an admin: the server
 * already commits to GitHub, so accounts can be managed entirely through the
 * web interface. Only GITHUB_TOKEN and SESSION_SECRET have to be set on the
 * host, and only once.
 *
 * Invite tokens are stored as SHA-256 hashes, so a copy of this file does not
 * let anyone redeem an outstanding invitation. Passwords are scrypt hashes.
 */

const DEFAULT_PATH = "admin/users.json";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MS = 15_000;

const EMPTY = { users: [], invites: [] };

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/** Compare two hex digests without leaking position through timing. */
function digestsMatch(a, b) {
  const bufA = Buffer.from(String(a), "hex");
  const bufB = Buffer.from(String(b), "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createUserStore({ gh, path = DEFAULT_PATH, fallbackUsers = "", now = () => Date.now() }) {
  let cache = null;
  let cachedAt = 0;
  let cachedSha = null;

  async function read({ fresh = false } = {}) {
    if (!fresh && cache && now() - cachedAt < CACHE_MS) return cache;
    const file = await gh.getFile(path).catch(() => null);
    if (!file) {
      cache = { ...EMPTY };
      cachedSha = null;
    } else {
      try {
        const parsed = JSON.parse(file.content);
        cache = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          invites: Array.isArray(parsed.invites) ? parsed.invites : []
        };
      } catch {
        cache = { ...EMPTY };
      }
      cachedSha = file.sha;
    }
    cachedAt = now();
    return cache;
  }

  async function write(data, message) {
    await gh.putFile({
      path,
      content: JSON.stringify(data, null, 2) + "\n",
      message,
      sha: cachedSha ?? undefined
    });
    // Force the next read to come from GitHub so the sha stays current.
    cache = null;
    cachedAt = 0;
    cachedSha = null;
  }

  return {
    /**
     * Look up a password hash for an email.
     * Falls back to ADMIN_USERS so an environment-configured account still
     * works — useful for recovery if the stored file is ever damaged.
     */
    async findHash(email) {
      const key = String(email ?? "").trim().toLowerCase();
      const data = await read();
      const found = data.users.find((u) => u.email === key);
      if (found) return found.hash;
      return parseUsers(fallbackUsers).get(key) ?? null;
    },

    /**
     * Only the owner may manage accounts.
     *
     * The owner is whichever record carries `owner: true`, falling back to
     * the first account in the file — the one that bootstrapped the admin.
     * That needs no configuration and no migration, and an explicit flag can
     * move it later without a code change.
     */
    async isOwner(email) {
      const key = String(email ?? "").trim().toLowerCase();
      if (!key) return false;
      const data = await read();
      // Recovery: with no accounts in the repository the only way to be
      // signed in at all is the environment fallback, and that account must
      // be able to repair things.
      if (data.users.length === 0) return true;
      const explicit = data.users.find((u) => u.owner === true);
      if (explicit) return explicit.email === key;
      return data.users[0]?.email === key;
    },

    async ownerEmail() {
      const data = await read();
      return (data.users.find((u) => u.owner === true) ?? data.users[0])?.email ?? null;
    },

    async listUsers() {
      const data = await read();
      const envUsers = [...parseUsers(fallbackUsers).keys()].map((email) => ({
        email,
        source: "environment"
      }));
      return [...data.users.map((u) => ({ ...u, source: "repository" })), ...envUsers];
    },

    async listInvites() {
      const data = await read();
      return data.invites.filter((i) => i.expires > now());
    },

    /** Returns the raw token, which is shown once and never stored. */
    async createInvite(email, invitedBy) {
      const key = String(email ?? "").trim().toLowerCase();
      if (!key.includes("@")) throw new Error("That does not look like an email address.");

      const data = await read({ fresh: true });
      if (data.users.some((u) => u.email === key)) {
        throw new Error(`${key} already has an account.`);
      }

      const token = randomBytes(32).toString("hex");
      const invites = data.invites
        .filter((i) => i.expires > now() && i.email !== key)
        .concat({
          email: key,
          tokenHash: hashToken(token),
          expires: now() + INVITE_TTL_MS,
          invitedBy
        });

      await write({ ...data, invites }, `Invite ${key} to the admin (by ${invitedBy})`);
      return token;
    },

    /** Find a live invite for a raw token, or null. */
    async findInvite(token) {
      if (!token) return null;
      const digest = hashToken(token);
      const data = await read({ fresh: true });
      return (
        data.invites.find((i) => i.expires > now() && digestsMatch(i.tokenHash, digest)) ?? null
      );
    },

    /** Redeem an invite, creating the account. */
    async redeemInvite(token, password) {
      const invite = await this.findInvite(token);
      if (!invite) throw new Error("That invitation is invalid or has expired.");
      if (String(password ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }

      const data = await read({ fresh: true });
      const hash = await hashPassword(password);
      const users = data.users
        .filter((u) => u.email !== invite.email)
        .concat({
          email: invite.email,
          hash,
          createdAt: new Date(now()).toISOString(),
          invitedBy: invite.invitedBy
        });
      const invites = data.invites.filter((i) => i.tokenHash !== invite.tokenHash);

      await write({ users, invites }, `Add admin ${invite.email}`);
      return invite.email;
    },

    /**
     * Create an account directly, with a password chosen by the person
     * creating it.
     *
     * Less private than an invitation — whoever sets the password knows it —
     * so it is meant for a temporary credential the new admin changes on
     * first sign-in. Any outstanding invitation for the same address is
     * cleared, so the two routes cannot leave contradictory state.
     */
    async createUser(email, password, createdBy) {
      const key = String(email ?? "").trim().toLowerCase();
      if (!key.includes("@")) throw new Error("That does not look like an email address.");
      if (String(password ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }

      const data = await read({ fresh: true });
      if (data.users.some((u) => u.email === key)) {
        throw new Error(`${key} already has an account.`);
      }

      const hash = await hashPassword(password);
      const users = data.users.concat({
        email: key,
        hash,
        createdAt: new Date(now()).toISOString(),
        createdBy,
        mustChangePassword: true
      });
      const invites = data.invites.filter((i) => i.email !== key);

      await write({ users, invites }, `Add admin ${key} (by ${createdBy})`);
      return key;
    },

    /**
     * Change your own password.
     *
     * Requires the current password, so a borrowed session cannot be used to
     * lock the real owner out. Accounts configured via ADMIN_USERS live in
     * the environment and cannot be edited from here.
     */
    async changePassword(email, currentPassword, newPassword) {
      const key = String(email ?? "").trim().toLowerCase();
      const data = await read({ fresh: true });
      const user = data.users.find((u) => u.email === key);

      if (!user) {
        throw new Error(
          "This account is configured on the server and cannot be changed here."
        );
      }
      if (!(await verifyPassword(currentPassword, user.hash))) {
        throw new Error("Your current password is not correct.");
      }
      if (String(newPassword ?? "").length < 12) {
        throw new Error("Please choose a password of at least 12 characters.");
      }
      if (await verifyPassword(newPassword, user.hash)) {
        throw new Error("That is the same as your current password.");
      }

      const hash = await hashPassword(newPassword);
      const users = data.users.map((u) =>
        u.email === key
          ? { ...u, hash, passwordChangedAt: new Date(now()).toISOString(), mustChangePassword: false }
          : u
      );
      await write({ ...data, users }, `Change admin password for ${key}`);
    },

    async removeUser(email, removedBy) {
      const key = String(email ?? "").trim().toLowerCase();
      const data = await read({ fresh: true });
      if (!data.users.some((u) => u.email === key)) {
        throw new Error("That account is not stored in the repository.");
      }
      if (data.users.length === 1) {
        throw new Error("That is the only remaining admin; add another before removing this one.");
      }
      await write(
        { ...data, users: data.users.filter((u) => u.email !== key) },
        `Remove admin ${key} (by ${removedBy})`
      );
    },

    async revokeInvite(email, revokedBy) {
      const key = String(email ?? "").trim().toLowerCase();
      const data = await read({ fresh: true });
      await write(
        { ...data, invites: data.invites.filter((i) => i.email !== key) },
        `Revoke admin invitation for ${key} (by ${revokedBy})`
      );
    },

    async verify(email, password) {
      const hash = await this.findHash(email);
      // Verify regardless, so an unknown account costs the same as a wrong
      // password and the form cannot be used to enumerate addresses.
      // The await matters: without it this compares a Promise, which is
      // always truthy, and every password would be accepted.
      const ok = await verifyPassword(password, hash ?? "scrypt$00$00");
      return ok && Boolean(hash);
    }
  };
}
