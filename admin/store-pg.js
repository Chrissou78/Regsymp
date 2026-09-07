import { ConflictError } from "./conflict.js";
import { digestOf, isBytes } from "./store-fs.js";

/**
 * Content store backed by Postgres.
 *
 * Exposes the same four methods the filesystem and GitHub stores do, so the
 * admin routes and the collection schemas above it do not know or care which
 * one they are talking to. That is the whole reason the interface was kept
 * this narrow: swapping the storage underneath is a wiring change, not a
 * rewrite of seven collection editors.
 */

const KEEP_REVISIONS = 50;

export function createPgStore({ db, keepRevisions = KEEP_REVISIONS, onWrite = null }) {
  /** Reject anything that is not a plain repository-relative path. */
  function clean(relative) {
    const value = String(relative ?? "").replace(/^\/+/, "");
    if (!value || value.includes("\0") || value.split("/").includes("..")) {
      throw new Error("Invalid path.");
    }
    return value;
  }

  async function getFile(relative) {
    let key;
    try {
      key = clean(relative);
    } catch {
      getFile.lastStatus = 400;
      return null;
    }

    const exact = await db.query(
      "select body, is_binary, digest from content_documents where path = $1",
      [key]
    );

    if (exact.rows.length) {
      getFile.lastStatus = 200;
      const buffer = exact.rows[0].body;
      return { content: buffer.toString("utf8"), buffer, sha: exact.rows[0].digest };
    }

    // No document at that exact path, so it may name a directory. The GitHub
    // Contents API answered a directory with a listing and storeImage still
    // relies on that to avoid overwriting an existing upload.
    const children = await db.query(
      "select path from content_documents where path like $1 order by path",
      [`${key}/%`]
    );

    if (!children.rows.length) {
      getFile.lastStatus = 404;
      return null;
    }

    getFile.lastStatus = 200;
    const seen = new Map();
    for (const row of children.rows) {
      const rest = row.path.slice(key.length + 1);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, slash === -1 ? "file" : "dir");
    }
    return [...seen].map(([name, type]) => ({ name, type }));
  }

  async function putFile({ path: relative, content, message, sha, isBinary = false, author = null }) {
    const key = clean(relative);
    // Never re-encode. Content arriving as bytes is stored as those bytes:
    // decoding a buffer to a string and back replaces anything that is not
    // valid UTF-8 with U+FFFD, which silently corrupted two SVGs that carry
    // non-UTF-8 bytes. `isBinary` is metadata, not an encoding instruction.
    const body = isBytes(content)
      ? Buffer.from(content)
      : Buffer.from(String(content), "utf8");
    const digest = digestOf(body);

    await db.tx(async (client) => {
      const current = await client.query(
        "select body, digest, updated_by from content_documents where path = $1 for update",
        [key]
      );
      const existing = current.rows[0];

      // Optimistic concurrency, exactly as the blob SHA gave us on GitHub: a
      // digest that no longer matches means somebody saved while this form
      // was open, so refuse rather than silently discard their edit.
      if (sha && existing && existing.digest !== sha) throw new ConflictError();

      if (existing) {
        await client.query(
          `insert into content_revisions (path, body, digest, updated_by)
           values ($1, $2, $3, $4)`,
          [key, existing.body, existing.digest, existing.updated_by]
        );
        await client.query(
          `delete from content_revisions
            where path = $1
              and id not in (
                select id from content_revisions
                 where path = $1
                 order by superseded_at desc, id desc
                 limit $2
              )`,
          [key, keepRevisions]
        );
      }

      await client.query(
        `insert into content_documents (path, body, is_binary, digest, updated_by, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (path) do update
            set body = excluded.body,
                is_binary = excluded.is_binary,
                digest = excluded.digest,
                updated_by = excluded.updated_by,
                updated_at = now()`,
        [key, body, isBinary, digest, author ?? authorFrom(message)]
      );
    });

    if (onWrite) await onWrite({ path: key, digest, isBinary, buffer: body, message });
    return { commit: { sha: digest, htmlUrl: null } };
  }

  /** Identifiers of the kept previous versions of a path, newest first. */
  async function listRevisions(relative) {
    const { rows } = await db.query(
      `select id from content_revisions
        where path = $1
        order by superseded_at desc, id desc`,
      [clean(relative)]
    );
    return rows.map((r) => String(r.id));
  }

  async function readRevision(relative, id) {
    if (!/^\d+$/.test(String(id))) throw new Error("Invalid revision.");
    const { rows } = await db.query(
      "select body from content_revisions where path = $1 and id = $2",
      [clean(relative), Number(id)]
    );
    if (!rows.length) throw new Error("No such revision.");
    return rows[0].body.toString("utf8");
  }

  /** Every stored path, for materialising the working tree at boot. */
  async function listAll(prefix = "") {
    const { rows } = await db.query(
      "select path, digest, is_binary from content_documents where path like $1 order by path",
      [`${prefix}%`]
    );
    return rows;
  }

  return { getFile, putFile, listRevisions, readRevision, listAll };
}

/**
 * The admin puts the signed-in address in every save message, which is where
 * attribution used to come from once one token made all the commits. Keep
 * reading it from there so the column is populated without changing callers.
 */
function authorFrom(message) {
  const match = String(message ?? "").match(/\(([^()]+@[^()]+)\)\s*$/);
  return match ? match[1] : null;
}
