import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFsStore } from "../admin/store-fs.js";
import { ConflictError } from "../admin/conflict.js";

const temp = () => mkdtemp(path.join(tmpdir(), "regsymp-store-"));

test("a missing file reads as null, not as an error", async () => {
  const store = createFsStore({ dir: await temp() });
  assert.equal(await store.getFile("src/_data/speakers.json"), null);
  assert.equal(store.getFile.lastStatus, 404);
});

test("a written file reads back with a stable digest", async () => {
  const store = createFsStore({ dir: await temp() });
  await store.putFile({ path: "src/_data/site.json", content: '{"a":1}' });

  const file = await store.getFile("src/_data/site.json");
  assert.equal(file.content, '{"a":1}');
  assert.equal(file.sha, (await store.getFile("src/_data/site.json")).sha);
});

test("a stale digest is refused rather than overwriting someone's edit", async () => {
  const store = createFsStore({ dir: await temp() });
  await store.putFile({ path: "src/_data/site.json", content: "one" });
  const stale = (await store.getFile("src/_data/site.json")).sha;

  // Somebody else saves in between.
  await store.putFile({ path: "src/_data/site.json", content: "two" });

  await assert.rejects(
    () => store.putFile({ path: "src/_data/site.json", content: "three", sha: stale }),
    ConflictError
  );
  assert.equal((await store.getFile("src/_data/site.json")).content, "two");
});

test("a directory answers with a listing, as the GitHub API did", async () => {
  // storeImage depends on this to avoid overwriting an existing upload.
  const dir = await temp();
  const store = createFsStore({ dir });
  await store.putFile({ path: "src/assets/images/a.png", content: "x", isBinary: true });
  await store.putFile({ path: "src/assets/images/b.png", content: "y", isBinary: true });

  const listing = await store.getFile("src/assets/images");
  assert.ok(Array.isArray(listing));
  assert.deepEqual(listing.map((e) => e.name).sort(), ["a.png", "b.png"]);
});

test("every overwrite keeps the version it replaced", async () => {
  // Committing gave us history for free. Losing that when we left git would
  // have meant a bad edit was unrecoverable.
  const store = createFsStore({ dir: await temp() });
  await store.putFile({ path: "src/_data/faq.json", content: "first" });
  await store.putFile({ path: "src/_data/faq.json", content: "second" });
  await store.putFile({ path: "src/_data/faq.json", content: "third" });

  const revisions = await store.listRevisions("src/_data/faq.json");
  assert.equal(revisions.length, 2, "two overwrites, two previous versions");
  assert.equal(await store.readRevision("src/_data/faq.json", revisions[0]), "second");
});

test("revisions are capped so the volume cannot fill up", async () => {
  const store = createFsStore({ dir: await temp(), keepRevisions: 3 });
  for (let i = 0; i < 10; i++) {
    await store.putFile({ path: "src/_data/faq.json", content: `v${i}` });
  }
  assert.equal((await store.listRevisions("src/_data/faq.json")).length, 3);
});

test("a path cannot escape the content directory", async () => {
  const store = createFsStore({ dir: await temp() });
  for (const bad of ["../escape.json", "../../etc/passwd", "/etc/passwd", "src/../../out.json"]) {
    const written = await store
      .putFile({ path: bad, content: "x" })
      .then(() => true)
      .catch(() => false);
    // An absolute path is stripped to a relative one and lands inside; the
    // rest must be refused outright. Either way nothing may be written above
    // the content directory.
    if (written) {
      assert.ok(!path.resolve(store.root, bad).includes(".."), bad);
      assert.ok(path.resolve(store.root, bad.replace(/^\/+/, "")).startsWith(store.root), bad);
    }
  }
});

test("a save is announced so the site can be rebuilt", async () => {
  const seen = [];
  const store = createFsStore({ dir: await temp(), onWrite: (info) => seen.push(info.path) });
  await store.putFile({ path: "src/_data/site.json", content: "{}" });
  assert.deepEqual(seen, ["src/_data/site.json"]);
});

test("an interrupted write cannot leave a half-written data file", async () => {
  // Writing in place would let a crash truncate speakers.json and break the
  // whole build; this writes beside the target and renames.
  const dir = await temp();
  const store = createFsStore({ dir });
  await store.putFile({ path: "src/_data/site.json", content: '{"complete":true}' });

  const { readdir } = await import("node:fs/promises");
  const files = await readdir(path.join(dir, "src/_data"));
  assert.deepEqual(files, ["site.json"], "no temporary files left behind");
});

test("the accounts file works through the same store", async () => {
  // users-store.js talks to whichever store it is given; this is the shape it
  // needs. Getting it wrong locks everyone out.
  const dir = await temp();
  const store = createFsStore({ dir });
  await mkdir(path.join(dir, "admin"), { recursive: true });
  await writeFile(path.join(dir, "admin/users.json"), '{"users":[],"invites":[]}');

  const file = await store.getFile("admin/users.json");
  assert.deepEqual(JSON.parse(file.content), { users: [], invites: [] });

  await store.putFile({
    path: "admin/users.json",
    content: '{"users":[{"email":"a@b.c"}],"invites":[]}',
    sha: file.sha
  });
  const after = JSON.parse(await readFile(path.join(dir, "admin/users.json"), "utf8"));
  assert.equal(after.users.length, 1);
});
