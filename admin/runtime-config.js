import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { env } from "../api/_lib/send-invitation.js";

/**
 * Configuration that can be supplied at runtime through a one-time setup
 * link, for hosts where nobody can reach the environment.
 *
 * Values live in memory only. The container filesystem is wiped on redeploy,
 * so there is nowhere durable to put a secret without the environment — which
 * means a genuine process restart loses whatever was set here and a fresh
 * setup link is needed. Environment variables always win when present, so
 * configuring the host properly supersedes this without any code change.
 */
const runtime = new Map();

export function configValue(name) {
  return env(name) || runtime.get(name) || "";
}

export function setRuntimeConfig(values) {
  for (const [key, value] of Object.entries(values)) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) runtime.set(key, trimmed);
  }
}

export function isConfigured() {
  return Boolean(configValue("GITHUB_TOKEN"));
}

/** Where the config came from, for the health endpoint. */
export function configSource(name) {
  if (env(name)) return "environment";
  if (runtime.get(name)) return "setup-link";
  return null;
}

export function hashSetupToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Compare a supplied setup token against the expected digest.
 * Constant-time, and false for anything malformed.
 */
export function setupTokenMatches(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const given = Buffer.from(hashSetupToken(token), "hex");
  let expected;
  try {
    expected = Buffer.from(String(expectedHash).trim(), "hex");
  } catch {
    return false;
  }
  if (expected.length !== given.length || expected.length === 0) return false;
  return timingSafeEqual(given, expected);
}

export function newSetupToken() {
  return randomBytes(32).toString("hex");
}
