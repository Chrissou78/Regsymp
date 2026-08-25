import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Guards against the whole class of bug that had four speaker photos and the
 * entire carousel 404ing in production: a path whose casing differs from the
 * file on disk. Windows and macOS resolve it happily; Vercel's Linux does not.
 *
 * Checked against the source tree rather than the build, so it holds whether
 * or not the image pipeline has rewritten URLs.
 */

const IMAGE_ROOT = "src/assets/images";

async function walk(dir, base = dir) {
  const out = new Set();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const nested of await walk(full, base)) out.add(nested);
    } else {
      out.add(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

async function templates(dir = "src") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await templates(full)));
    else if (/\.(njk|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("every referenced image exists with exactly matching case", async () => {
  const onDisk = await walk(IMAGE_ROOT);
  const files = await templates();
  const missing = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const m of source.matchAll(/\/assets\/images\/([^"'\s)}]+)/g)) {
      const ref = m[1];
      // skip Nunjucks-interpolated paths; those are covered by the data tests
      if (ref.includes("{{") || ref.includes("{%")) continue;
      if (!onDisk.has(ref)) {
        const ciMatch = [...onDisk].find((f) => f.toLowerCase() === ref.toLowerCase());
        missing.push(
          `${file}: /assets/images/${ref}` +
            (ciMatch ? `  <-- case mismatch, file is "${ciMatch}"` : "  <-- no such file")
        );
      }
    }
  }

  assert.deepEqual(missing, [], "unresolvable image references:\n" + missing.join("\n"));
});

test("data-file image references resolve too", async () => {
  const onDisk = await walk(IMAGE_ROOT);
  const speakers = JSON.parse(await readFile("src/_data/speakers.json", "utf8"));
  const partners = JSON.parse(await readFile("src/_data/partners.json", "utf8"));

  const missing = [];
  for (const s of speakers) {
    if (s.photo && !onDisk.has("speakers/" + s.photo)) {
      missing.push(`speakers.json: ${s.slug} -> speakers/${s.photo}`);
    }
  }
  for (const row of partners) {
    for (const logo of row.logos) {
      if (!onDisk.has(logo.file)) missing.push(`partners.json: ${logo.name} -> ${logo.file}`);
    }
  }
  assert.deepEqual(missing, [], "missing image files:\n" + missing.join("\n"));
});

test("no image path uses uppercase directory segments", async () => {
  const onDisk = await walk(IMAGE_ROOT);
  const offenders = [...onDisk].filter((f) => {
    const dirs = f.split("/").slice(0, -1);
    return dirs.some((d) => d !== d.toLowerCase());
  });
  assert.deepEqual(offenders, [], "uppercase directories invite case bugs:\n" + offenders.join("\n"));
});
