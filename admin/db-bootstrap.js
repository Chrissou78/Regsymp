import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { digestOf } from "./store-fs.js";
import { CONTENT_PATHS, CONTENT_FILES } from "./content-dir.js";

/**
 * Getting existing content and accounts into Postgres, and back out onto disk
 * for the build.
 *
 * The deployed checkout is the migration source. It already contains the last
 * committed content and, on the deploy branch, the accounts file — so a first
 * boot against an empty database carries everything over without anyone
 * exporting or importing anything.
 */

/** Every file under a directory, as project-relative paths. */
async function walk(root, relative, found = []) {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const next = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await walk(root, next, found);
    else found.push(next);
  }
  return found;
}

const TEXT = /\.(json|md|txt|svg|njk|html|css|js)$/i;

/**
 * Copy the checkout into the database, but only into an empty one.
 *
 * Guarded on emptiness rather than on a marker file: a database that already
 * holds content is authoritative, and re-seeding it would overwrite live edits
 * with whatever the last deploy happened to ship.
 */
export async function seedContent({ db, store, root, paths = CONTENT_PATHS }) {
  const { rows } = await db.query("select count(*)::int as n from content_documents");
  if (rows[0].n > 0) return { seeded: false, documents: rows[0].n };

  let documents = 0;
  for (const base of paths) {
    for (const relative of await walk(root, base)) {
      const buffer = await readFile(path.join(root, relative));
      await store.putFile({
        path: relative,
        content: buffer,
        isBinary: !TEXT.test(relative),
        message: "Seed from the deployed checkout",
        author: "migration"
      });
      documents += 1;
    }
  }
  return { seeded: true, documents };
}

/**
 * Move the accounts file into the admin_users table, once.
 *
 * Only runs when there are no accounts, for the same reason as above. Hashes
 * are carried across verbatim, so everybody's existing password still works.
 */
export async function seedAdmins({ db, root, files = CONTENT_FILES }) {
  const { rows } = await db.query("select count(*)::int as n from admin_users");
  if (rows[0].n > 0) return { seeded: false, accounts: rows[0].n };

  const source = files.find((f) => f.endsWith("users.json"));
  if (!source) return { seeded: false, accounts: 0 };

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path.join(root, source), "utf8"));
  } catch {
    return { seeded: false, accounts: 0 }; // nothing to migrate; first-run handles it
  }

  const users = Array.isArray(parsed.users) ? parsed.users : [];
  if (!users.length) return { seeded: false, accounts: 0 };

  // Preserve who the owner was: the explicit flag if present, else the first
  // record, which is how the document store resolved it.
  const ownerEmail = (users.find((u) => u.owner === true) ?? users[0]).email;

  let accounts = 0;
  await db.tx(async (client) => {
    for (const user of users) {
      if (!user?.email || !user?.hash) continue;
      await client.query(
        `insert into admin_users
           (email, password_hash, is_owner, must_change_password, created_at, created_by)
         values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6)
         on conflict (email) do nothing`,
        [
          String(user.email).toLowerCase(),
          user.hash,
          String(user.email).toLowerCase() === String(ownerEmail).toLowerCase(),
          Boolean(user.mustChangePassword),
          user.createdAt ?? null,
          user.createdBy ?? "migrated from users.json"
        ]
      );
      accounts += 1;
    }
  });
  return { seeded: true, accounts };
}

/**
 * Write one document to the working tree, atomically.
 *
 * Eleventy builds from files, so the database has to reach disk before a build
 * means anything. Renaming into place keeps a half-written data file from ever
 * being what the build reads.
 */
export async function writeThrough({ root, relative, buffer }) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, buffer);
  await rename(tmp, target);
}

/**
 * Bring the working tree in line with the database.
 *
 * Compares digests rather than copying unconditionally: almost nothing changes
 * between restarts, and rewriting eighty images every boot would be pure cost.
 */
export async function materialise({ db, store, root, prefix = "src/" }) {
  const documents = await store.listAll(prefix);
  let written = 0;

  for (const doc of documents) {
    const target = path.join(root, doc.path);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile()) {
      const onDisk = digestOf(await readFile(target));
      if (onDisk === doc.digest) continue;
    }
    const file = await store.getFile(doc.path);
    if (!file || Array.isArray(file)) continue;
    await writeThrough({ root, relative: doc.path, buffer: file.buffer });
    written += 1;
  }
  return { documents: documents.length, written };
}
