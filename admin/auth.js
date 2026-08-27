import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const EIGHT_HOURS = 8 * 60 * 60 * 1000;

/**
 * Server-side session store.
 *
 * Sessions hold the GitHub OAuth token, so they must never reach the
 * browser — the cookie carries only an opaque identifier. In-memory is
 * deliberate: a container restart signs everyone out, which is acceptable
 * for a handful of users and avoids adding a session store.
 */
export function createSessions({ ttlMs = EIGHT_HOURS } = {}) {
  const store = new Map();

  function sweep() {
    const now = Date.now();
    for (const [id, session] of store) {
      if (session.expires <= now) store.delete(id);
    }
  }

  return {
    create(user, token) {
      sweep();
      const id = randomBytes(24).toString("hex");
      store.set(id, { user, token, expires: Date.now() + ttlMs });
      return id;
    },
    get(id) {
      if (!id) return undefined;
      const session = store.get(id);
      if (!session) return undefined;
      if (session.expires <= Date.now()) {
        store.delete(id);
        return undefined;
      }
      return session;
    },
    destroy(id) {
      store.delete(id);
    },
    size() {
      sweep();
      return store.size;
    }
  };
}

/** CSRF token bound to a session, so it is useless in any other session. */
export function csrfToken(sessionId, secret) {
  return createHmac("sha256", String(secret)).update(String(sessionId)).digest("hex");
}

export function verifyCsrf(sessionId, token, secret) {
  const expected = csrfToken(sessionId, secret);
  const given = String(token ?? "");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * Exact, case-insensitive allowlist check.
 * An empty allowlist permits nobody — failing closed matters more here
 * than convenience, since this guards write access to the repository.
 */
export function isAllowed(login, allowlist) {
  const names = String(allowlist ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return false;
  return names.includes(String(login ?? "").trim().toLowerCase());
}

export function authorizeUrl({ clientId, redirectUri, state }) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "repo");
  url.searchParams.set("state", state);
  return url.toString();
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}
