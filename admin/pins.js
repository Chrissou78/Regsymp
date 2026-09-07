import { isImagePath } from "./ipfs.js";

/**
 * Recording which images are on IPFS.
 *
 * Pinning is best-effort on purpose. The bytes are already durable in
 * Postgres, which is what the site is served from, so a Pinata outage must
 * never fail a save — it just leaves the CID to be filled in later.
 *
 * That makes "not pinned" ambiguous, though: not attempted, or attempted and
 * failed. Whoever administers this cannot read a server log, so failures are
 * recorded with their reason and the count of attempts.
 */

export async function findCid(db, digest) {
  const { rows } = await db.query("select cid from asset_pins where digest = $1", [digest]);
  return rows[0]?.cid ?? null;
}

export async function recordPin(db, { digest, cid, bytes, filename, provider = "pinata" }) {
  await db.tx(async (client) => {
    await client.query(
      `insert into asset_pins (digest, cid, bytes, filename, provider)
       values ($1, $2, $3, $4, $5)
       on conflict (digest) do update
          set cid = excluded.cid,
              bytes = excluded.bytes,
              filename = excluded.filename,
              provider = excluded.provider,
              pinned_at = now()`,
      [digest, cid, bytes, filename ?? null, provider]
    );
    // It worked, so any recorded reason for it not having worked is stale.
    await client.query("delete from asset_pin_failures where digest = $1", [digest]);
  });
}

async function recordFailure(db, { digest, path, error }) {
  await db.query(
    `insert into asset_pin_failures (digest, path, error)
     values ($1, $2, $3)
     on conflict (digest) do update
        set error = excluded.error,
            path = excluded.path,
            attempts = asset_pin_failures.attempts + 1,
            last_attempt = now()`,
    [digest, path ?? null, String(error).slice(0, 500)]
  );
}

/**
 * Pin one document, unless those exact bytes are already pinned.
 *
 * Returns what happened rather than throwing: every caller here is on a path
 * where failing loudly would be worse than carrying on.
 */
export async function pinDocument(db, pinner, { path, digest, buffer }) {
  if (!isImagePath(path)) return { skipped: "not an image" };
  if (!pinner.configured()) return { skipped: "pinning not configured" };

  const existing = await findCid(db, digest);
  if (existing) return { cid: existing, alreadyPinned: true };

  try {
    const { cid, size } = await pinner.pin({
      buffer,
      filename: path.split("/").pop()
    });
    await recordPin(db, { digest, cid, bytes: size, filename: path.split("/").pop() });
    return { cid, pinned: true };
  } catch (err) {
    await recordFailure(db, { digest, path, error: err.message });
    return { failed: err.message };
  }
}

/**
 * Pin everything not yet pinned.
 *
 * Deliberately a separate action rather than something boot does: the first
 * run uploads every image on the site, and a deploy is not the moment to
 * discover how long that takes or that a credential has expired.
 */
export async function backfill(db, store, pinner, { limit = 500, onProgress = null } = {}) {
  if (!pinner.configured()) return { skipped: "pinning not configured" };

  const { rows } = await db.query(
    `select d.path, d.digest
       from content_documents d
       left join asset_pins p on p.digest = d.digest
      where p.digest is null
      order by d.path
      limit $1`,
    [limit]
  );

  const images = rows.filter((r) => isImagePath(r.path));
  const result = { considered: images.length, pinned: 0, failed: 0, errors: [] };

  for (const row of images) {
    const file = await store.getFile(row.path);
    if (!file || Array.isArray(file)) continue;

    const outcome = await pinDocument(db, pinner, {
      path: row.path,
      digest: row.digest,
      buffer: file.buffer
    });

    if (outcome.pinned || outcome.alreadyPinned) result.pinned += 1;
    if (outcome.failed) {
      result.failed += 1;
      result.errors.push(`${row.path}: ${outcome.failed}`);
    }
    if (onProgress) onProgress({ path: row.path, ...outcome });
  }
  return result;
}

/**
 * How much of the site is on IPFS. Counts and reasons, never a credential.
 */
export async function pinStatus(db) {
  const [images, pinned, failures] = await Promise.all([
    db.query(
      `select count(*)::int n from content_documents
        where path ~* '\\.(jpe?g|png|webp|avif|gif|svg)$'`
    ),
    db.query(
      `select count(*)::int n from content_documents d
         join asset_pins p on p.digest = d.digest
        where d.path ~* '\\.(jpe?g|png|webp|avif|gif|svg)$'`
    ),
    db.query(
      `select path, error, attempts, last_attempt
         from asset_pin_failures
        order by last_attempt desc
        limit 5`
    )
  ]);

  return {
    images: images.rows[0].n,
    pinned: pinned.rows[0].n,
    unpinned: images.rows[0].n - pinned.rows[0].n,
    failures: failures.rows.map((r) => ({
      path: r.path,
      error: r.error,
      attempts: r.attempts,
      lastAttempt: r.last_attempt
    }))
  };
}

/** Every pinned image with its CID, for the admin and for exports. */
export async function listPins(db) {
  const { rows } = await db.query(
    `select d.path, p.cid, p.bytes, p.pinned_at
       from content_documents d
       join asset_pins p on p.digest = d.digest
      order by d.path`
  );
  return rows.map((r) => ({
    path: r.path,
    cid: r.cid,
    bytes: r.bytes,
    pinnedAt: r.pinned_at
  }));
}
