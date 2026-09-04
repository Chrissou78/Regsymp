import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTENT_PATHS,
  durability,
  ensureContentDir,
  mirror,
  persistentSecret,
  syncToWorkingTree
} from "../admin/content-dir.js";

const temp = () => mkdtemp(path.join(tmpdir(), "regsymp-vol-"));

/** A miniature checkout: the paths the admin can edit, and the accounts file. */
async function fakeCheckout() {
  const root = await temp();
  await mkdir(path.join(root, "src/_data"), { recursive: true });
  await mkdir(path.join(root, "src/assets/images"), { recursive: true });
  await mkdir(path.join(root, "admin"), { recursive: true });
  await writeFile(path.join(root, "src/_data/speakers.json"), '[{"slug":"a"}]');
  await writeFile(path.join(root, "src/assets/images/logo.png"), "png-bytes");
  await writeFile(path.join(root, "admin/users.json"), '{"users":[{"email":"chris@x.com"}]}');
  return root;
}

test("a new volume is seeded from the deployed checkout", async () => {
  // Otherwise a fresh volume would bring the site up blank.
  const root = await fakeCheckout();
  const dir = await temp();

  const first = await ensureContentDir({ dir, root });
  assert.equal(first.seeded, true);
  assert.equal(await readFile(path.join(dir, "src/_data/speakers.json"), "utf8"), '[{"slug":"a"}]');
});

test("existing admin accounts move onto the volume with the content", async () => {
  // admin/users.json is kept out of the public repo but does ship in the
  // deployed branch. Not seeding it would strand every existing admin.
  const root = await fakeCheckout();
  const dir = await temp();
  await ensureContentDir({ dir, root });

  const accounts = JSON.parse(await readFile(path.join(dir, "admin/users.json"), "utf8"));
  assert.equal(accounts.users[0].email, "chris@x.com");
});

test("a volume that already has content is never re-seeded over", async () => {
  // This is the whole point: the volume outranks the deployed checkout.
  const root = await fakeCheckout();
  const dir = await temp();
  await ensureContentDir({ dir, root });

  // An admin edits, then a deploy ships different data files.
  await writeFile(path.join(dir, "src/_data/speakers.json"), '[{"slug":"edited-live"}]');
  await writeFile(path.join(root, "src/_data/speakers.json"), '[{"slug":"stale-from-git"}]');

  const second = await ensureContentDir({ dir, root });
  assert.equal(second.seeded, false);
  assert.equal(
    await readFile(path.join(dir, "src/_data/speakers.json"), "utf8"),
    '[{"slug":"edited-live"}]',
    "the deploy must not overwrite what the admin saved"
  );
});

test("the volume is copied over the working tree, so the build uses it", async () => {
  const root = await fakeCheckout();
  const dir = await temp();
  await ensureContentDir({ dir, root });
  await writeFile(path.join(dir, "src/_data/speakers.json"), '[{"slug":"live"}]');

  await syncToWorkingTree({ dir, root });
  assert.equal(await readFile(path.join(root, "src/_data/speakers.json"), "utf8"), '[{"slug":"live"}]');
});

test("syncing again copies nothing when the trees already match", async () => {
  // Boot copies the whole content tree; without this it would rewrite every
  // image on every restart.
  const root = await fakeCheckout();
  const dir = await temp();
  await ensureContentDir({ dir, root });
  await syncToWorkingTree({ dir, root });
  assert.equal(await syncToWorkingTree({ dir, root }), 0);
});

test("mirror ignores dot-directories, so revisions never reach the site", async () => {
  const from = await temp();
  const to = await temp();
  await mkdir(path.join(from, ".revisions/src"), { recursive: true });
  await writeFile(path.join(from, ".revisions/src/old.bak"), "old");
  await writeFile(path.join(from, "keep.json"), "keep");

  await mirror(from, to);
  await assert.rejects(() => readFile(path.join(to, ".revisions/src/old.bak"), "utf8"));
  assert.equal(await readFile(path.join(to, "keep.json"), "utf8"), "keep");
});

test("the session secret is generated once and then reused", async () => {
  // Regenerating per boot would invalidate every open form's CSRF token.
  const dir = await temp();
  const first = await persistentSecret({ dir });
  assert.ok(first.length >= 32);
  assert.equal(await persistentSecret({ dir }), first);
});

test("a volume that did not persist is reported, not assumed durable", async () => {
  // An unmounted volume behaves exactly like a mounted one until the next
  // deploy erases it. Content younger than the process is the tell.
  const wiped = durability({
    marker: { createdAt: new Date().toISOString() },
    seeded: false,
    uptimeSeconds: 3600
  });
  assert.equal(wiped.durable, false);

  const survived = durability({
    marker: { createdAt: new Date(Date.now() - 86_400_000).toISOString() },
    seeded: false,
    uptimeSeconds: 60
  });
  assert.equal(survived.durable, true);

  // Just seeded: unknown rather than falsely reassuring.
  const fresh = durability({ marker: { createdAt: new Date().toISOString() }, seeded: true, uptimeSeconds: 5 });
  assert.equal(fresh.durable, null);
});

test("the seeded paths cover everything the admin can write", async () => {
  // A collection whose file sits outside these paths would be edited on the
  // volume and silently lost, or never seeded at all.
  const { SCHEMAS } = await import("../admin/schemas.js");
  for (const schema of Object.values(SCHEMAS)) {
    assert.ok(
      CONTENT_PATHS.some((p) => schema.file.startsWith(p + "/")),
      `${schema.file} is not covered by CONTENT_PATHS`
    );
    for (const f of [...schema.fields, ...(schema.childFields ?? [])]) {
      if (f.type !== "image") continue;
      assert.ok(
        CONTENT_PATHS.some((p) => f.dir === p || f.dir.startsWith(p + "/")),
        `${f.dir} is not covered by CONTENT_PATHS`
      );
    }
  }
});
