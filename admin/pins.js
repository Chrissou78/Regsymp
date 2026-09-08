import { isImagePath } from "./ipfs.js";
import { encrypt } from "./crypto.js";

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

export async function recordPin(
  db,
  { digest, cid, bytes, filename, provider = "pinata", encrypted = false, algo = null }
) {
  await db.tx(async (client) => {
    await client.query(
      `insert into asset_pins (digest, cid, bytes, filename, provider, encrypted, algo)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (digest) do update
          set cid = excluded.cid,
              bytes = excluded.bytes,
              filename = excluded.filename,
              provider = excluded.provider,
              encrypted = excluded.encrypted,
              algo = excluded.algo,
              pinned_at = now()`,
      [digest, cid, bytes, filename ?? null, provider, encrypted, algo]
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
export async function pinDocument(db, pinner, { path, digest, buffer, key = process.env.IPFS_ENCRYPTION_KEY }) {
  if (!isImagePath(path)) return { skipped: "not an image" };
  if (!pinner.configured()) return { skipped: "pinning not configured" };

  const existing = await pinFor(db, digest);
  // Already pinned and already in the state we want. A plaintext pin from
  // before encryption was turned on is deliberately *not* treated as done.
  if (existing && existing.encrypted === Boolean(key)) {
    return { cid: existing.cid, alreadyPinned: true };
  }

  const filename = path.split("/").pop();

  try {
    // Encrypted before it leaves this process. IPFS cannot un-publish
    // anything, so uploading plaintext first and encrypting later would be
    // no protection at all.
    const payload = key ? encrypt(buffer, key) : buffer;
    const { cid, size } = await pinner.pin({
      buffer: payload,
      filename: key ? `${filename}.enc` : filename,
      // Encrypted bytes are not an image and should not be labelled as one.
      ...(key ? { mime: "application/octet-stream" } : {})
    });

    await recordPin(db, {
      digest,
      cid,
      bytes: size,
      filename,
      encrypted: Boolean(key),
      algo: key ? "aes-256-gcm" : null
    });

    // The plaintext copy is now redundant, and leaving it pinned would defeat
    // the encryption entirely.
    const retired = existing && existing.cid !== cid && !existing.encrypted
      ? await pinner.unpin(existing.cid).then(() => existing.cid, () => null)
      : null;

    return { cid, pinned: true, encrypted: Boolean(key), retired };
  } catch (err) {
    await recordFailure(db, { digest, path, error: err.message });
    return { failed: err.message };
  }
}

/** The current pin for a digest, with its encryption state. */
export async function pinFor(db, digest) {
  const { rows } = await db.query(
    "select cid, encrypted, algo from asset_pins where digest = $1",
    [digest]
  );
  return rows[0] ?? null;
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

  // Not yet pinned, or pinned in the wrong state — a plaintext copy when a
  // key is set, or an encrypted one when it is not.
  const wantEncrypted = Boolean(process.env.IPFS_ENCRYPTION_KEY);
  const { rows } = await db.query(
    `select d.path, d.digest
       from content_documents d
       left join asset_pins p on p.digest = d.digest
      where p.digest is null
         or p.encrypted is distinct from $2
      order by d.path
      limit $1`,
    [limit, wantEncrypted]
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
  const [images, pinned, encrypted, failures] = await Promise.all([
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
      `select count(*)::int n from content_documents d
         join asset_pins p on p.digest = d.digest
        where p.encrypted
          and d.path ~* '\\.(jpe?g|png|webp|avif|gif|svg)$'`
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
    encrypted: encrypted.rows[0].n,
    plaintext: pinned.rows[0].n - encrypted.rows[0].n,
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
    `select d.path, p.cid, p.bytes, p.pinned_at, p.encrypted, p.digest
       from content_documents d
       join asset_pins p on p.digest = d.digest
      order by d.path`
  );
  return rows.map((r) => ({
    path: r.path,
    cid: r.cid,
    bytes: r.bytes,
    pinnedAt: r.pinned_at,
    encrypted: r.encrypted,
    digest: r.digest
  }));
}

/**
 * The stored copy of a pinned image, found by its digest.
 *
 * The database holds the plaintext, so a thumbnail needs no gateway round
 * trip and no decryption -- which matters on a page showing eighty of them.
 */
export async function documentByDigest(db, digest) {
  if (!/^[0-9a-f]{40}$/.test(String(digest ?? ""))) return null;
  const { rows } = await db.query(
    `select d.path, d.body, p.cid, p.encrypted
       from content_documents d
       join asset_pins p on p.digest = d.digest
      where d.digest = $1
      limit 1`,
    [String(digest)]
  );
  return rows[0] ?? null;
}
