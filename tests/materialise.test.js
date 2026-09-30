import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materialise } from "../admin/db-bootstrap.js";
import { digestOf } from "../admin/store-fs.js";

/**
 * Writing the database's content onto disk, at boot.
 *
 * The case worth testing is the one that happened: staging's stored images had
 * been decoded as UTF-8 somewhere, so every byte above 0x7F was U+FFFD and a
 * PNG's leading 0x89 read as EF BF BD. This wrote them over the good files,
 * the build could not read them, and eleventy-img -- deliberately configured
 * not to fail the build -- left a half-resolved path in the markup. The site
 * served broken images for a week and nothing said a word.
 */

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
]);

/** The same bytes after a trip through a UTF-8 string, which is the bug. */
const mangled = (buffer) => Buffer.from(buffer.toString("utf8"), "utf8");

/** A store holding exactly what it is given. */
function storeOf(files) {
  return {
    listAll: async () =>
      Object.entries(files).map(([p, buffer]) => ({ path: p, digest: digestOf(buffer) })),
    getFile: async (p) => (files[p] ? { buffer: files[p], sha: digestOf(files[p]) } : null)
  };
}

const quiet = { error() {}, log() {} };

async function root() {
  const dir = await mkdtemp(path.join(tmpdir(), "regsymp-mat-"));
  await mkdir(path.join(dir, "src/assets/images"), { recursive: true });
  return dir;
}

test("a stored image that is not an image is not written over the one on disk", async () => {
  const dir = await root();
  const onDisk = path.join(dir, "src/assets/images/logo.png");
  await writeFile(onDisk, PNG);

  const result = await materialise({
    db: null,
    store: storeOf({ "src/assets/images/logo.png": mangled(PNG) }),
    root: dir,
    log: quiet
  });

  assert.deepEqual(result.refused, ["src/assets/images/logo.png"]);
  assert.equal(result.written, 0);
  // The good file is still the good file.
  assert.deepEqual(await readFile(onDisk), PNG);
});

test("a good image is written, so the guard does not stop the ordinary case", async () => {
  const dir = await root();
  const target = path.join(dir, "src/assets/images/logo.png");
  await writeFile(target, Buffer.from("something else entirely"));

  const result = await materialise({
    db: null,
    store: storeOf({ "src/assets/images/logo.png": PNG }),
    root: dir,
    log: quiet
  });

  assert.deepEqual(result.refused, []);
  assert.equal(result.written, 1);
  assert.deepEqual(await readFile(target), PNG);
});

test("an image the disk does not have yet is still refused when it is broken", async () => {
  // Writing a corrupt file where there was none is no better: the build then
  // cannot read it either, and a missing file at least says so.
  const dir = await root();
  const result = await materialise({
    db: null,
    store: storeOf({ "src/assets/images/new.png": mangled(PNG) }),
    root: dir,
    log: quiet
  });

  assert.deepEqual(result.refused, ["src/assets/images/new.png"]);
  assert.equal(result.written, 0);
});

test("text is written without being sniffed", async () => {
  // Only images are checked. JSON and templates have no magic bytes, and
  // demanding one would refuse every data file on the site.
  const dir = await root();
  await mkdir(path.join(dir, "src/_data"), { recursive: true });
  const body = Buffer.from('{"hello":"world"}', "utf8");

  const result = await materialise({
    db: null,
    store: storeOf({ "src/_data/site.json": body }),
    root: dir,
    log: quiet
  });

  assert.equal(result.written, 1);
  assert.deepEqual(await readFile(path.join(dir, "src/_data/site.json")), body);
});

test("an SVG counts as an image, and a broken one is refused", async () => {
  const dir = await root();
  const good = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
  const dir2 = await root();

  assert.equal(
    (
      await materialise({
        db: null,
        store: storeOf({ "src/assets/images/mark.svg": good }),
        root: dir,
        log: quiet
      })
    ).written,
    1
  );

  assert.deepEqual(
    (
      await materialise({
        db: null,
        store: storeOf({ "src/assets/images/mark.svg": Buffer.from("not markup at all") }),
        root: dir2,
        log: quiet
      })
    ).refused,
    ["src/assets/images/mark.svg"]
  );
});

test("it says which files it refused, because silence is how this lasted a week", async () => {
  const dir = await root();
  const said = [];
  await materialise({
    db: null,
    store: storeOf({
      "src/assets/images/a.png": mangled(PNG),
      "src/assets/images/b.png": mangled(PNG)
    }),
    root: dir,
    log: { error: (m) => said.push(m), log() {} }
  });

  assert.equal(said.length, 1);
  assert.match(said[0], /2 stored image\(s\) are not images/);
  assert.match(said[0], /a\.png/);
});
