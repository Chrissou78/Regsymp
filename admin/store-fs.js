import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConflictError } from "./conflict.js";

/**
 * Content store backed by a directory on disk.
 *
 * It exposes exactly the interface the GitHub client does — `getFile` and
 * `putFile` — so the admin routes and the user store work against either
 * without knowing which they have.
 *
 * The reason for it: committing every edit meant every edit triggered a
 * redeploy. That cost three to five minutes before a change appeared, signed
 * everyone out when the new container replaced the old one, and wiped any
 * configuration held in memory — including the token that made saving work at
 * all. Writing to a mounted volume instead makes a save a local file write.
 *
 * What git gave us for free was history, so this keeps its own: every
 * overwrite snapshots the previous contents under `.revisions/`.
 */

const REVISION_DIR = ".revisions";
const KEEP_REVISIONS = 50;

// Uploaded images are content-addressed by filename and never overwritten,
// so snapshotting them would only burn disk. Data files are a few KB.
const MAX_REVISION_BYTES = 1024 * 1024;

export function digestOf(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

export function createFsStore({
  dir,
  keepRevisions = KEEP_REVISIONS,
  onWrite = null,
  now = () => new Date()
}) {
  const root = path.resolve(dir);

  /** Resolve a repository-relative path, refusing anything that escapes. */
  function resolve(relative) {
    const clean = String(relative ?? "").replace(/^[\/]+/, "");
    if (clean.includes("\0")) throw new Error("Invalid path.");
    const target = path.resolve(root, clean);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error("Invalid path.");
    }
    return { target, clean };
  }

  async function getFile(relative) {
    let target;
    try {
      ({ target } = resolve(relative));
    } catch {
      getFile.lastStatus = 400;
      return null;
    }

    let info;
    try {
      info = await stat(target);
    } catch {
      getFile.lastStatus = 404;
      return null;
    }
    getFile.lastStatus = 200;

    // A directory answers with a listing, as the GitHub Contents API does.
    // storeImage depends on that to avoid overwriting an existing upload.
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
    }

    const buffer = await readFile(target);
    return { content: buffer.toString("utf8"), buffer, sha: digestOf(buffer) };
  }

  /** Keep the outgoing version before it is replaced. */
  async function snapshot(target, clean) {
    let buffer;
    try {
      const info = await stat(target);
      if (!info.isFile() || info.size > MAX_REVISION_BYTES) return;
      buffer = await readFile(target);
    } catch {
      return; // nothing there yet: the first write has no previous version
    }

    const bucket = path.join(root, REVISION_DIR, clean);
    await mkdir(bucket, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    await writeFile(path.join(bucket, `${stamp}.bak`), buffer);

    const kept = (await readdir(bucket)).filter((n) => n.endsWith(".bak")).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - keepRevisions))) {
      await unlink(path.join(bucket, stale)).catch(() => {});
    }
  }

  async function putFile({ path: relative, content, message, sha, isBinary = false }) {
    const { target, clean } = resolve(relative);
    const next = isBinary ? Buffer.from(content) : Buffer.from(String(content), "utf8");

    if (sha) {
      const current = await getFile(clean);
      if (current && !Array.isArray(current) && current.sha !== sha) throw new ConflictError();
    }

    await snapshot(target, clean);
    await mkdir(path.dirname(target), { recursive: true });

    // Write beside the target and rename: a crash mid-write must not be able
    // to leave a half-written data file, which would break the whole site.
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, next);
    await rename(tmp, target);

    if (onWrite) await onWrite({ path: clean, absolute: target, message });
    return { commit: { sha: digestOf(next), htmlUrl: null } };
  }

  /** Timestamps of the kept previous versions of a file, newest first. */
  async function listRevisions(relative) {
    const { clean } = resolve(relative);
    const bucket = path.join(root, REVISION_DIR, clean);
    try {
      return (await readdir(bucket))
        .filter((n) => n.endsWith(".bak"))
        .sort()
        .reverse()
        .map((n) => n.replace(/\.bak$/, ""));
    } catch {
      return [];
    }
  }

  async function readRevision(relative, stamp) {
    const { clean } = resolve(relative);
    if (!/^[\w-]+$/.test(String(stamp))) throw new Error("Invalid revision.");
    const file = path.join(root, REVISION_DIR, clean, `${stamp}.bak`);
    return readFile(file, "utf8");
  }

  return { root, getFile, putFile, listRevisions, readRevision };
}
