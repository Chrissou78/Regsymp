import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

// Deliberately costly. scrypt is memory-hard, so these parameters make an
// offline attack on a leaked hash expensive while costing ~100ms per login.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * Hash a password for storage in an environment variable.
 * Format: scrypt$<saltHex>$<keyHex> — self-describing, so the parameters
 * can change later without invalidating existing hashes.
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(String(password), salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Always performs the full derivation, even for a malformed hash, so the
 * response time does not reveal whether an account exists.
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  const usable = parts.length === 3 && parts[0] === "scrypt";

  const salt = usable ? Buffer.from(parts[1], "hex") : randomBytes(SALT_BYTES);
  const expected = usable ? Buffer.from(parts[2], "hex") : randomBytes(KEY_LENGTH);

  let derived;
  try {
    derived = await scryptAsync(String(password ?? ""), salt, expected.length || KEY_LENGTH, {
      N,
      r: R,
      p: P
    });
  } catch {
    return false;
  }

  if (!usable) return false;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Parse ADMIN_USERS: comma-separated `email:scrypt$salt$key` pairs.
 *
 * Returns a Map keyed by lowercased email. An empty or malformed value
 * yields an empty map, so the admin fails closed rather than open.
 */
export function parseUsers(raw) {
  const users = new Map();
  for (const entry of String(raw ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    if (at === -1) continue;
    const email = trimmed.slice(0, at).trim().toLowerCase();
    const hash = trimmed.slice(at + 1).trim();
    if (!email.includes("@") || !hash.startsWith("scrypt$")) continue;
    users.set(email, hash);
  }
  return users;
}
