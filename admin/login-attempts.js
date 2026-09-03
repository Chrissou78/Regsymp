/**
 * Per-IP login throttling.
 *
 * A password form is brute-forceable in a way OAuth was not, so failed
 * attempts are counted and the source is locked out temporarily. Counters
 * live in memory, which is fine at this scale: a restart clears them, and
 * the worst case is an attacker getting a fresh allowance after a deploy.
 */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

export function createAttemptLimiter({
  maxAttempts = MAX_ATTEMPTS,
  windowMs = WINDOW_MS,
  now = () => Date.now()
} = {}) {
  const attempts = new Map();

  function prune() {
    const cutoff = now() - windowMs;
    for (const [key, record] of attempts) {
      if (record.last <= cutoff) attempts.delete(key);
    }
  }

  return {
    /** True when this source has exhausted its allowance. */
    isLocked(key) {
      prune();
      const record = attempts.get(key);
      return Boolean(record && record.count >= maxAttempts);
    },

    /** Seconds until the lock expires, for the message shown to the user. */
    retryAfter(key) {
      const record = attempts.get(key);
      if (!record) return 0;
      return Math.max(0, Math.ceil((record.last + windowMs - now()) / 1000));
    },

    fail(key) {
      prune();
      const record = attempts.get(key) ?? { count: 0, last: 0 };
      record.count += 1;
      record.last = now();
      attempts.set(key, record);
      return record.count;
    },

    succeed(key) {
      attempts.delete(key);
    },

    size() {
      prune();
      return attempts.size;
    }
  };
}
