import { randomBytes } from "node:crypto";
import { generateKey } from "./crypto.js";

/**
 * Service credentials held in the database.
 *
 * They are loaded once at boot and assigned into `process.env`, which is what
 * every existing consumer already reads. That keeps one configuration path for
 * both this server and the Vercel functions, which have no database.
 *
 * DATABASE_URL is not manageable here and never can be: reading this table
 * needs a connection, and the connection needs that value. It stays an
 * environment variable, and it is the only one that has to.
 */

/**
 * Only these names may be written.
 *
 * This list is a security boundary, not tidiness. Assigning arbitrary names
 * into process.env from a web form would let anyone who reached the page set
 * NODE_OPTIONS or PATH and run code in the server process.
 */
export const MANAGED = Object.freeze([
  "RESEND_API_KEY",
  "RESEND_FROM",
  "INVITATION_RECIPIENT",
  "SESSION_SECRET",
  "PINATA_JWT",
  "PINATA_API_KEY",
  "PINATA_API_SECRET",
  "PINATA_GATEWAY",
  "IPFS_ENCRYPTION_KEY",
  "WALLETWALLET_API_KEY"
]);

/**
 * What each credential is for, shown beside its field.
 *
 * Without this the page is a column of shouty constant names and no clue
 * which value belongs in which box — which is how a secret ends up pasted
 * into the wrong field and then wondered about.
 */
export const DESCRIPTIONS = Object.freeze({
  RESEND_API_KEY: "From the Resend dashboard. Starts with re_. Sends the invitation emails.",
  RESEND_FROM: "Sender address, on a domain verified in Resend. e.g. RegSymp <noreply@send.regsymp.com>",
  INVITATION_RECIPIENT: "Where invitation requests are delivered. e.g. info@regsymp.com",
  SESSION_SECRET: "Signs CSRF tokens. Generated automatically; replace it only to invalidate every open form.",
  PINATA_JWT: "Pinata API Key JWT. This alone is enough to pin files — prefer it over the key and secret pair.",
  PINATA_API_KEY: "Pinata legacy API key. Only needed if you are using the older v2 authentication.",
  PINATA_API_SECRET: "Pinata legacy API secret, paired with the key above.",
  PINATA_GATEWAY: "Your dedicated gateway host, e.g. something.mypinata.cloud. No https://, no trailing slash.",
  IPFS_ENCRYPTION_KEY:
    "Encrypts every image before it is pinned. Generated automatically. Keep a copy somewhere else: lose it and the pinned copies are unreadable.",
  WALLETWALLET_API_KEY:
    "Issues Apple and Google Wallet passes for tickets. Without it, tickets still work — the QR code is served from this site either way."
});

export function isManaged(name) {
  return MANAGED.includes(String(name));
}

export async function loadSecrets(db) {
  const { rows } = await db.query("select name, value from app_secrets");
  return new Map(rows.filter((r) => isManaged(r.name)).map((r) => [r.name, r.value]));
}

/**
 * Load and apply. The database wins over an existing environment variable on
 * purpose: otherwise changing a credential in the admin would appear to work
 * and silently do nothing, because a stale dashboard value still shadowed it.
 */
export async function applySecrets(db) {
  const secrets = await loadSecrets(db);
  for (const [name, value] of secrets) process.env[name] = value;
  return [...secrets.keys()];
}

export async function setSecret(db, name, value, updatedBy) {
  if (!isManaged(name)) throw new Error(`${name} is not a managed credential.`);
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error("A value is required.");

  await db.query(
    `insert into app_secrets (name, value, updated_by, updated_at)
     values ($1, $2, $3, now())
     on conflict (name) do update
        set value = excluded.value,
            updated_by = excluded.updated_by,
            updated_at = now()`,
    [name, trimmed, updatedBy ?? null]
  );
  process.env[name] = trimmed;
}

export async function clearSecret(db, name) {
  if (!isManaged(name)) throw new Error(`${name} is not a managed credential.`);
  await db.query("delete from app_secrets where name = $1", [name]);
  delete process.env[name];
}

/**
 * Which credentials are configured and where from — names, booleans and
 * timestamps only. A status endpoint that echoes a secret is worse than no
 * status endpoint.
 */
export async function secretStatus(db) {
  const { rows } = await db.query("select name, updated_at, updated_by from app_secrets");
  const stored = new Map(rows.map((r) => [r.name, r]));
  return MANAGED.map((name) => ({
    name,
    help: DESCRIPTIONS[name] ?? "",
    set: Boolean(process.env[name]),
    source: stored.has(name) ? "database" : process.env[name] ? "environment" : null,
    updatedAt: stored.get(name)?.updated_at ?? null,
    updatedBy: stored.get(name)?.updated_by ?? null
  }));
}

/**
 * A session secret that outlives the process, so restarts do not invalidate
 * every open form's CSRF token. Generated once, then read back.
 */
export async function ensureSessionSecret(db) {
  const { rows } = await db.query("select value from app_secrets where name = 'SESSION_SECRET'");
  if (rows[0]?.value) {
    process.env.SESSION_SECRET = rows[0].value;
    return rows[0].value;
  }
  const generated = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
  await setSecret(db, "SESSION_SECRET", generated, "generated on first boot");
  return generated;
}

/**
 * The key used to encrypt images before they are pinned.
 *
 * Generated on first use rather than required as configuration, so encryption
 * is on by default — IPFS is public, and an unencrypted upload cannot be
 * recalled once its CID is known.
 */
export async function ensureEncryptionKey(db) {
  const { rows } = await db.query("select value from app_secrets where name = 'IPFS_ENCRYPTION_KEY'");
  if (rows[0]?.value) {
    process.env.IPFS_ENCRYPTION_KEY = rows[0].value;
    return rows[0].value;
  }
  const generated = process.env.IPFS_ENCRYPTION_KEY || generateKey();
  await setSecret(db, "IPFS_ENCRYPTION_KEY", generated, "generated on first use");
  return generated;
}
