/**
 * Settings the running site consults on a request.
 *
 * Read often -- every page view asks whether the site is asleep -- and written
 * rarely, so the answer is held for a few seconds rather than fetched each
 * time. The window is short enough that switching the site on or off feels
 * immediate, and long enough that a burst of traffic is one query rather than
 * thousands.
 *
 * It is a cache with a clock rather than one invalidated on write because
 * there can be more than one instance: an instance that did not serve the
 * write would otherwise keep serving the old answer for as long as it stayed
 * up. A few seconds of disagreement is a price worth paying for that.
 */

const TTL_MS = 5000;

export const SLEEP_DEFAULT = Object.freeze({
  on: false,
  heading: "Thank you.",
  message: "We are closed for a little while, working on the next experience."
});

export function createSettings({ db, ttlMs = TTL_MS, now = () => Date.now() }) {
  const cache = new Map();

  async function read(key) {
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.value;

    const { rows } = await db.query("select value from site_settings where key = $1", [key]);
    const value = rows[0]?.value ?? null;
    cache.set(key, { value, until: now() + ttlMs });
    return value;
  }

  return {
    /** Whatever is stored under a key, or null. */
    get: read,

    async set(key, value, updatedBy = null) {
      await db.query(
        `insert into site_settings (key, value, updated_by)
         values ($1, $2::jsonb, $3)
         on conflict (key) do update
            set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [key, JSON.stringify(value), updatedBy]
      );
      // This instance at least should not be a step behind its own write.
      cache.set(key, { value, until: now() + ttlMs });
      return value;
    },

    /**
     * Whether the site is closed, and what it says while it is.
     *
     * Defaulted rather than left null so that a missing row -- a database
     * restored from before this existed, say -- means open. The failure this
     * avoids is a site that puts itself to sleep because a query came back
     * empty.
     */
    async sleep() {
      const stored = (await read("sleep")) ?? {};
      return {
        on: stored.on === true,
        heading: String(stored.heading ?? "").trim() || SLEEP_DEFAULT.heading,
        message: String(stored.message ?? "").trim() || SLEEP_DEFAULT.message
      };
    },

    /** Forget what is held, for a test or an immediate re-read. */
    forget() {
      cache.clear();
    }
  };
}
