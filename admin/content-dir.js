import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The content volume: where everything the admin can edit actually lives.
 *
 * The deployed checkout is disposable — a redeploy replaces it — so the data
 * files and uploaded images have to live somewhere the container does not
 * own. That is this directory, and it is the source of truth: on boot its
 * contents are copied over the working tree, then Eleventy builds from them.
 *
 * The practical consequence, and it matters: once a volume is seeded, editing
 * `src/_data/*.json` in git no longer changes the site. The volume wins.
 */

const MARKER = ".regsymp-content.json";
const SECRET = ".session-secret";

/** Everything the admin may write, relative to the project root. */
export const CONTENT_PATHS = ["src/_data", "src/assets/images"];

/**
 * Single files that move with the content.
 *
 * The accounts file is the one that matters: it is kept out of the public
 * repository but does ship in the deployed branch, so seeding it here
 * migrates the existing admins onto the volume instead of stranding them.
 */
export const CONTENT_FILES = ["admin/users.json"];

/** Copy one file if the destination is missing or older. */
export async function mirrorFile(src, dst) {
  const source = await stat(src).catch(() => null);
  if (!source || !source.isFile()) return 0;
  const existing = await stat(dst).catch(() => null);
  if (existing && existing.size === source.size && existing.mtimeMs >= source.mtimeMs) return 0;
  await mkdir(path.dirname(dst), { recursive: true });
  await cp(src, dst, { force: true });
  return 1;
}

/**
 * Copy a tree, skipping files that are already identical.
 *
 * Boot copies the whole content tree, most of which never changes, so
 * comparing first keeps startup to a few milliseconds instead of rewriting
 * every image on every restart.
 */
export async function mirror(from, to) {
  let entries;
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch {
    return 0; // nothing to copy from
  }

  await mkdir(to, { recursive: true });
  let copied = 0;

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copied += await mirror(src, dst);
      continue;
    }

    const source = await stat(src);
    const existing = await stat(dst).catch(() => null);
    if (existing && existing.size === source.size && existing.mtimeMs >= source.mtimeMs) continue;

    await cp(src, dst, { force: true });
    copied += 1;
  }
  return copied;
}

/**
 * Prepare the content directory, seeding it from the checkout if it is new.
 *
 * A brand-new volume is empty. Seeding it from the shipped code means the
 * site comes up with the content it deployed with, rather than blank — and
 * it makes the migration from git a no-op: first boot copies what is there.
 */
export async function ensureContentDir({ dir, root, paths = CONTENT_PATHS, files: single = CONTENT_FILES }) {
  await mkdir(dir, { recursive: true });

  let marker = null;
  try {
    marker = JSON.parse(await readFile(path.join(dir, MARKER), "utf8"));
  } catch {
    /* absent: either a fresh volume, or one that did not persist */
  }

  const seeded = !marker;
  if (seeded) {
    let files = 0;
    for (const rel of paths) files += await mirror(path.join(root, rel), path.join(dir, rel));
    for (const rel of single) files += await mirrorFile(path.join(root, rel), path.join(dir, rel));
    marker = {
      id: randomBytes(8).toString("hex"),
      createdAt: new Date().toISOString(),
      seededFiles: files
    };
    await writeFile(path.join(dir, MARKER), JSON.stringify(marker, null, 2) + "\n");
  }

  return { dir, marker, seeded };
}

/** Copy the volume over the working tree, so Eleventy builds from it. */
export async function syncToWorkingTree({ dir, root, paths = CONTENT_PATHS }) {
  let copied = 0;
  for (const rel of paths) copied += await mirror(path.join(dir, rel), path.join(root, rel));
  return copied;
}

/**
 * A session secret that survives a restart, kept on the volume.
 *
 * Generating one per boot would invalidate every open form's CSRF token on
 * every restart. Keeping it here means one less thing anybody has to set.
 */
export async function persistentSecret({ dir }) {
  const file = path.join(dir, SECRET);
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* generate below */
  }
  const secret = randomBytes(32).toString("hex");
  await writeFile(file, secret + "\n", { mode: 0o600 });
  return secret;
}

/**
 * Is this directory actually durable?
 *
 * A volume that was never mounted still works — it is just a directory in the
 * container — and silently loses everything on the next deploy. The marker's
 * age is the tell: if the content is younger than the process, it was created
 * by this boot, which means the previous boot's content did not survive.
 */
export function durability({ marker, seeded, uptimeSeconds }) {
  if (!marker) return { durable: false, reason: "no marker written" };
  const ageSeconds = Math.round((Date.now() - Date.parse(marker.createdAt)) / 1000);
  if (seeded) return { durable: null, ageSeconds, reason: "seeded this boot; unproven until the next restart" };
  return {
    durable: ageSeconds > uptimeSeconds,
    ageSeconds,
    reason: ageSeconds > uptimeSeconds ? "content predates this process" : "content is younger than this process"
  };
}
