import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, migrate } from "../admin/db.js";
import { createPgStore } from "../admin/store-pg.js";
import { createPgUserStore } from "../admin/users-store-pg.js";
import { ConflictError } from "../admin/conflict.js";
import { seedAdmins, seedContent, materialise } from "../admin/db-bootstrap.js";
import {
  MANAGED,
  applySecrets,
  clearSecret,
  ensureSessionSecret,
  secretStatus,
  setSecret
} from "../admin/secrets.js";
import { hashPassword } from "../admin/password.js";
import { backfill, findCid, listPins, pinDocument, pinStatus, recordPin } from "../admin/pins.js";

/**
 * These need a real Postgres, because what they are testing *is* the SQL:
 * transactions, the partial unique index, row locking, upserts. A stub would
 * only assert that my mock behaves like my mock.
 *
 * Start one with:
 *   docker run -d --name regsymp-dev-pg -e POSTGRES_PASSWORD=dev \
 *     -e POSTGRES_DB=regsymp -p 55432:5432 postgres:18
 * then set TEST_DATABASE_URL before running the suite.
 */
const URL = process.env.TEST_DATABASE_URL;

/**
 * These tests truncate tables, so they must never reach a live database.
 * Refused unless the target is plainly local, or somebody has said out loud
 * that they mean it.
 */
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe =
  URL &&
  !LOCAL.test(URL) &&
  process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run the Postgres tests" }
  : unsafe
    ? {
        skip:
          "REFUSED: TEST_DATABASE_URL is not a local database and these tests " +
          "truncate content_documents and admin_users. Point it at a throwaway " +
          "Postgres, or set ALLOW_DESTRUCTIVE_DB_TESTS=1 if you truly mean it."
      }
    : {};

if (unsafe) {
  console.error(
    [
      "",
      "  refusing to run the Postgres tests: TEST_DATABASE_URL is not local.",
      "  they truncate tables, so this would delete live content and accounts.",
      ""
    ].join("\n")
  );
}

let db;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
});

after(async () => {
  if (db) await db.end();
});

/** A clean slate, so no test depends on another's leftovers. */
async function reset() {
  await db.query("truncate content_documents, content_revisions");
  await db.query("delete from admin_users");
  await db.query("delete from app_secrets");
  await db.query("truncate asset_pins, asset_pin_failures");
}

/** A pinner that records calls instead of uploading anything. */
function stubPinner({ fails = false } = {}) {
  const calls = [];
  return {
    calls,
    configured: () => true,
    gatewayUrl: (cid) => `https://gw.test/ipfs/${cid}`,
    async pin({ buffer, filename }) {
      calls.push(filename);
      if (fails) throw new Error("Pinata returned 401");
      // Real CIDs are content-addressed, so model that: same bytes, same CID.
      return { cid: `bafy${buffer.length}`, size: buffer.length };
    }
  };
}

// -------------------------------------------------------------- migrations

test("migrations are idempotent", opts, async () => {
  // Boot runs these on every start, so a second application must do nothing.
  assert.deepEqual(await migrate(db), [], "a second run applied something");
});

test("the schema has the tables the stores expect", opts, async () => {
  const { rows } = await db.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
  );
  const tables = rows.map((r) => r.table_name);
  for (const expected of ["admin_users", "app_secrets", "content_documents", "content_revisions"]) {
    assert.ok(tables.includes(expected), `missing ${expected}`);
  }
});

// ----------------------------------------------------------- content store

test("a document round-trips with a stable digest", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  assert.equal(await store.getFile("src/_data/site.json"), null);
  assert.equal(store.getFile.lastStatus, 404);

  await store.putFile({ path: "src/_data/site.json", content: '{"a":1}' });
  const file = await store.getFile("src/_data/site.json");
  assert.equal(file.content, '{"a":1}');
  assert.equal(file.sha, (await store.getFile("src/_data/site.json")).sha);
});

test("a stale digest is refused rather than overwriting another edit", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  await store.putFile({ path: "src/_data/site.json", content: "one" });
  const stale = (await store.getFile("src/_data/site.json")).sha;
  await store.putFile({ path: "src/_data/site.json", content: "two" });

  await assert.rejects(
    () => store.putFile({ path: "src/_data/site.json", content: "three", sha: stale }),
    ConflictError
  );
  assert.equal((await store.getFile("src/_data/site.json")).content, "two");
});

test("a directory answers with a listing, as the GitHub API did", opts, async () => {
  // storeImage relies on this to avoid overwriting an existing upload.
  await reset();
  const store = createPgStore({ db });
  await store.putFile({ path: "src/assets/images/a.png", content: Buffer.from([1]), isBinary: true });
  await store.putFile({
    path: "src/assets/images/speakers/b.jpg",
    content: Buffer.from([2]),
    isBinary: true
  });

  const listing = await store.getFile("src/assets/images");
  assert.ok(Array.isArray(listing));
  assert.deepEqual(
    listing.sort((x, y) => x.name.localeCompare(y.name)),
    [
      { name: "a.png", type: "file" },
      { name: "speakers", type: "dir" }
    ]
  );
});

test("binary content survives the round trip byte for byte", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
  await store.putFile({ path: "src/assets/images/x.png", content: bytes, isBinary: true });
  assert.deepEqual((await store.getFile("src/assets/images/x.png")).buffer, bytes);
});

test("bytes that are not valid UTF-8 survive unchanged", opts, async () => {
  // Two real SVGs in this repository carry non-UTF-8 bytes. Storing them as
  // "text" decoded and re-encoded them, replacing each bad byte with U+FFFD:
  // 201 KB became 318 KB of corrupted file. Bytes in, the same bytes out.
  await reset();
  const store = createPgStore({ db });
  const awkward = Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xc3, 0x28, 0xa0, 0xff, 0xfe, 0x3e]);

  await store.putFile({ path: "src/assets/images/awkward.svg", content: awkward });
  assert.deepEqual((await store.getFile("src/assets/images/awkward.svg")).buffer, awkward);

  // And through the seeder, which is what classified .svg as text.
  const root = await mkdtemp(path.join(tmpdir(), "regsymp-bytes-"));
  await mkdir(path.join(root, "src/assets/images"), { recursive: true });
  await writeFile(path.join(root, "src/assets/images/real.svg"), awkward);
  await reset();
  await seedContent({ db, store, root });
  assert.deepEqual((await store.getFile("src/assets/images/real.svg")).buffer, awkward);

  // And back out to disk, which is what the build reads.
  const out = await mkdtemp(path.join(tmpdir(), "regsymp-bytes-out-"));
  await materialise({ db, store, root: out });
  assert.deepEqual(await readFile(path.join(out, "src/assets/images/real.svg")), awkward);
});

test("every overwrite keeps the version it replaced, capped", opts, async () => {
  // Committing gave history for free; leaving git must not lose it.
  await reset();
  const store = createPgStore({ db, keepRevisions: 3 });
  for (let i = 0; i < 6; i++) {
    await store.putFile({ path: "src/_data/faq.json", content: `v${i}` });
  }
  const revisions = await store.listRevisions("src/_data/faq.json");
  assert.equal(revisions.length, 3, "the cap was not applied");
  assert.equal(await store.readRevision("src/_data/faq.json", revisions[0]), "v4");
});

test("a path cannot escape the key space", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  for (const bad of ["../escape.json", "src/../../out.json", "a/../../b"]) {
    await assert.rejects(() => store.putFile({ path: bad, content: "x" }), /Invalid path/);
  }
});

test("the signed-in address is recorded against the save", opts, async () => {
  // One token used to make every commit, so attribution came from the commit
  // message. Same source, now a column.
  await reset();
  const store = createPgStore({ db });
  await store.putFile({
    path: "src/_data/site.json",
    content: "{}",
    message: "Update site settings via admin (melih@onchainlabs.ch)"
  });
  const { rows } = await db.query("select updated_by from content_documents where path = $1", [
    "src/_data/site.json"
  ]);
  assert.equal(rows[0].updated_by, "melih@onchainlabs.ch");
});

// ------------------------------------------------------------------ accounts

test("the first account created owns the admin", opts, async () => {
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("chris@onchainlabs.ch", "long-enough-password", "first run");
  await users.createUser("melih@onchainlabs.ch", "another-long-password", "chris@onchainlabs.ch");

  assert.equal(await users.ownerEmail(), "chris@onchainlabs.ch");
  assert.equal(await users.isOwner("chris@onchainlabs.ch"), true);
  assert.equal(await users.isOwner("melih@onchainlabs.ch"), false);
});

test("two owners are unrepresentable", opts, async () => {
  // The owner is the only account that can manage accounts, so the database
  // refuses that state rather than trusting the application never to reach it.
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("chris@onchainlabs.ch", "long-enough-password", "first run");

  await assert.rejects(
    () =>
      db.query(`insert into admin_users (email, password_hash, is_owner) values ($1, $2, true)`, [
        "second@onchainlabs.ch",
        "scrypt$00$00"
      ]),
    /admin_users_single_owner|duplicate key/
  );
});

test("addresses are normalised, so case cannot create a second account", opts, async () => {
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("Chris@OnchainLabs.CH", "long-enough-password", "first run");
  assert.equal(await users.verify("chris@onchainlabs.ch", "long-enough-password"), true);
  await assert.rejects(
    () => users.createUser("CHRIS@onchainlabs.ch", "another-long-password", "x"),
    /already has an account/
  );
});

test("a wrong password and an unknown account are indistinguishable", opts, async () => {
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("chris@onchainlabs.ch", "long-enough-password", "first run");
  assert.equal(await users.verify("chris@onchainlabs.ch", "wrong-password"), false);
  assert.equal(await users.verify("nobody@example.com", "long-enough-password"), false);
});

test("changing a password requires the current one", opts, async () => {
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("chris@onchainlabs.ch", "long-enough-password", "first run");

  await assert.rejects(
    () => users.changePassword("chris@onchainlabs.ch", "not-the-password", "brand-new-password"),
    /not correct/
  );
  await assert.rejects(
    () => users.changePassword("chris@onchainlabs.ch", "long-enough-password", "short"),
    /at least 12/
  );

  await users.changePassword("chris@onchainlabs.ch", "long-enough-password", "brand-new-password");
  assert.equal(await users.verify("chris@onchainlabs.ch", "brand-new-password"), true);
  assert.equal(await users.verify("chris@onchainlabs.ch", "long-enough-password"), false);
});

test("the owner cannot be removed, nor the last account", opts, async () => {
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("chris@onchainlabs.ch", "long-enough-password", "first run");
  await assert.rejects(
    () => users.removeUser("chris@onchainlabs.ch", "chris@onchainlabs.ch"),
    /owner/
  );

  await users.createUser("melih@onchainlabs.ch", "another-long-password", "chris@onchainlabs.ch");
  await users.removeUser("melih@onchainlabs.ch", "chris@onchainlabs.ch");
  assert.equal((await users.listUsers()).length, 1);
});

test("a password is never stored in clear", opts, async () => {
  await reset();
  const users = createPgUserStore({ db });
  await users.createUser("chris@onchainlabs.ch", "long-enough-password", "first run");
  const { rows } = await db.query("select password_hash from admin_users");
  assert.ok(rows[0].password_hash.startsWith("scrypt$"));
  assert.ok(!rows[0].password_hash.includes("long-enough-password"));
});

// ----------------------------------------------------------------- migration

test("an empty database is seeded from the checkout, and only when empty", opts, async () => {
  // First boot has to bring the live content across without anyone running an
  // export. A later boot must not put the deploy's copy over live edits.
  await reset();
  const root = await mkdtemp(path.join(tmpdir(), "regsymp-seed-"));
  await mkdir(path.join(root, "src/_data"), { recursive: true });
  await mkdir(path.join(root, "src/assets/images"), { recursive: true });
  await writeFile(path.join(root, "src/_data/speakers.json"), '[{"slug":"a"}]');
  await writeFile(path.join(root, "src/assets/images/logo.png"), Buffer.from([1, 2, 3]));

  const store = createPgStore({ db });
  const first = await seedContent({ db, store, root });
  assert.equal(first.seeded, true);
  assert.equal(first.documents, 2);
  assert.equal((await store.getFile("src/_data/speakers.json")).content, '[{"slug":"a"}]');

  // An admin edits, then a deploy ships an older copy of the same file.
  await store.putFile({ path: "src/_data/speakers.json", content: '[{"slug":"edited-live"}]' });
  await writeFile(path.join(root, "src/_data/speakers.json"), '[{"slug":"stale-from-git"}]');

  const second = await seedContent({ db, store, root });
  assert.equal(second.seeded, false, "a populated database was re-seeded");
  assert.equal(
    (await store.getFile("src/_data/speakers.json")).content,
    '[{"slug":"edited-live"}]',
    "the deploy overwrote a live edit"
  );
});

test("existing admins are migrated with their hashes intact", opts, async () => {
  // Everybody's current password has to keep working across the move.
  await reset();
  const root = await mkdtemp(path.join(tmpdir(), "regsymp-admins-"));
  await mkdir(path.join(root, "admin"), { recursive: true });
  await writeFile(
    path.join(root, "admin/users.json"),
    JSON.stringify({
      users: [
        {
          email: "chris@onchainlabs.ch",
          hash: await hashPassword("their-existing-password"),
          createdAt: "2026-09-01T00:00:00.000Z"
        },
        { email: "melih@onchainlabs.ch", hash: await hashPassword("other-password") }
      ],
      invites: []
    })
  );

  const result = await seedAdmins({ db, root });
  assert.equal(result.seeded, true);
  assert.equal(result.accounts, 2);

  const users = createPgUserStore({ db });
  assert.equal(await users.verify("chris@onchainlabs.ch", "their-existing-password"), true);
  assert.equal(await users.ownerEmail(), "chris@onchainlabs.ch", "the first record stays owner");

  assert.equal((await seedAdmins({ db, root })).seeded, false, "re-ran against a populated table");
});

test("materialise writes the database onto disk for the build", opts, async () => {
  // Eleventy builds from files, so the database has to reach disk first.
  await reset();
  const root = await mkdtemp(path.join(tmpdir(), "regsymp-mat-"));
  const store = createPgStore({ db });
  await store.putFile({ path: "src/_data/faq.json", content: '[{"question":"q"}]' });

  const first = await materialise({ db, store, root });
  assert.equal(first.written, 1);
  assert.equal(await readFile(path.join(root, "src/_data/faq.json"), "utf8"), '[{"question":"q"}]');

  const second = await materialise({ db, store, root });
  assert.equal(second.written, 0, "rewrote a file that already matched");
});

// --------------------------------------------------------------- credentials

test("credentials load from the database into the environment", opts, async () => {
  await reset();
  delete process.env.RESEND_API_KEY;
  await setSecret(db, "RESEND_API_KEY", "re_from_database", "chris@onchainlabs.ch");
  await applySecrets(db);
  assert.equal(process.env.RESEND_API_KEY, "re_from_database");

  await clearSecret(db, "RESEND_API_KEY");
  assert.equal(process.env.RESEND_API_KEY, undefined);
});

test("only known credentials can be written", opts, async () => {
  // A security boundary, not tidiness: writing arbitrary names into
  // process.env from a web form would let NODE_OPTIONS run code here.
  await reset();
  for (const dangerous of ["NODE_OPTIONS", "PATH", "DATABASE_URL", "LD_PRELOAD"]) {
    await assert.rejects(() => setSecret(db, dangerous, "x", "attacker"), /not a managed credential/);
  }
  assert.ok(!MANAGED.includes("DATABASE_URL"), "the connection string must not be manageable");
});

test("every managed credential is described, and the connection string is not one", opts, async () => {
  // A column of bare constant names is how a value gets pasted into the wrong
  // box. And DATABASE_URL must never be manageable: reading this table needs
  // the connection that value opens.
  const status = await secretStatus(db);
  for (const entry of status) {
    assert.ok(entry.help && entry.help.length > 20, `${entry.name} has no description`);
  }
  assert.ok(!MANAGED.includes("DATABASE_URL"));
  for (const expected of ["PINATA_JWT", "PINATA_API_KEY", "PINATA_API_SECRET", "PINATA_GATEWAY"]) {
    assert.ok(MANAGED.includes(expected), `${expected} is not manageable`);
  }
});

test("a Pinata JWT is stored whole, however long it is", opts, async () => {
  // JWTs run to several hundred characters; a truncated one fails at pin time
  // with an authentication error that looks like a wrong key.
  await reset();
  const jwt = "eyJhbGciOiJIUzI1NiJ9." + "x".repeat(600) + ".signature";
  await setSecret(db, "PINATA_JWT", jwt, "chris@onchainlabs.ch");
  await applySecrets(db);
  assert.equal(process.env.PINATA_JWT, jwt);
  assert.equal(process.env.PINATA_JWT.length, jwt.length);
  delete process.env.PINATA_JWT;
});

test("the session secret is generated once and then reused", opts, async () => {
  await reset();
  delete process.env.SESSION_SECRET;
  const first = await ensureSessionSecret(db);
  assert.ok(first.length >= 32);
  assert.equal(await ensureSessionSecret(db), first);
});

test("credential status reports names, never values", opts, async () => {
  await reset();
  await setSecret(db, "RESEND_API_KEY", "re_super_secret_value", "chris@onchainlabs.ch");
  const status = await secretStatus(db);

  assert.ok(!JSON.stringify(status).includes("re_super_secret_value"), "status leaked a credential");
  const entry = status.find((s) => s.name === "RESEND_API_KEY");
  assert.equal(entry.set, true);
  assert.equal(entry.source, "database");
});

// ---------------------------------------------------------------------- IPFS

test("only images are pinned", opts, async () => {
  await reset();
  const pinner = stubPinner();

  const json = await pinDocument(db, pinner, {
    path: "src/_data/faq.json",
    digest: "d1",
    buffer: Buffer.from("[]")
  });
  assert.deepEqual(json, { skipped: "not an image" });
  assert.equal(pinner.calls.length, 0, "uploaded a data file");
});

test("nothing is attempted without a credential", opts, async () => {
  await reset();
  const result = await pinDocument(db, { configured: () => false }, {
    path: "src/assets/images/a.png",
    digest: "d1",
    buffer: Buffer.from([1])
  });
  assert.deepEqual(result, { skipped: "pinning not configured" });
});

test("identical bytes are pinned once, however many paths use them", opts, async () => {
  // Pins are keyed on the content digest because a CID is derived from the
  // bytes. Keying on the path would pay for the same upload twice.
  await reset();
  const pinner = stubPinner();
  const buffer = Buffer.from([1, 2, 3, 4]);

  const first = await pinDocument(db, pinner, { path: "src/assets/images/a.png", digest: "same", buffer });
  const second = await pinDocument(db, pinner, { path: "src/assets/images/b.png", digest: "same", buffer });

  assert.equal(first.pinned, true);
  assert.equal(second.alreadyPinned, true);
  assert.equal(second.cid, first.cid);
  assert.equal(pinner.calls.length, 1, "uploaded the same bytes twice");
});

test("a failure records why, and counts the attempts", opts, async () => {
  // Pinning is best-effort, so "not pinned" is ambiguous: never tried, or
  // tried and failed. Whoever administers this cannot read a server log.
  await reset();
  const broken = stubPinner({ fails: true });
  const image = { path: "src/assets/images/a.png", digest: "d1", buffer: Buffer.from([1]) };

  const result = await pinDocument(db, broken, image);
  assert.match(result.failed, /401/);

  await pinDocument(db, broken, image);
  const { rows } = await db.query("select error, attempts from asset_pin_failures where digest = $1", ["d1"]);
  assert.equal(rows[0].attempts, 2);
  assert.match(rows[0].error, /401/);
});

test("a later success clears the recorded failure", opts, async () => {
  // Otherwise the admin would keep reporting a problem that had been fixed.
  await reset();
  const image = { path: "src/assets/images/a.png", digest: "d1", buffer: Buffer.from([1]) };

  await pinDocument(db, stubPinner({ fails: true }), image);
  assert.equal((await db.query("select 1 from asset_pin_failures")).rows.length, 1);

  await pinDocument(db, stubPinner(), image);
  assert.equal((await db.query("select 1 from asset_pin_failures")).rows.length, 0);
  assert.ok(await findCid(db, "d1"));
});

test("a failure never stops a save", opts, async () => {
  // The bytes are already durable in Postgres and the page is already built.
  // Throwing here would fail an edit that had in fact succeeded.
  await reset();
  const result = await pinDocument(db, stubPinner({ fails: true }), {
    path: "src/assets/images/a.png",
    digest: "d1",
    buffer: Buffer.from([1])
  });
  assert.ok(result.failed, "expected a reported failure, not a thrown one");
});

test("backfill pins what is missing, then has nothing to do", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  await store.putFile({ path: "src/assets/images/a.png", content: Buffer.from([1, 2]) });
  await store.putFile({ path: "src/assets/images/b.jpg", content: Buffer.from([1, 2, 3]) });
  await store.putFile({ path: "src/_data/faq.json", content: "[]" });

  const pinner = stubPinner();
  const first = await backfill(db, store, pinner);
  assert.equal(first.considered, 2, "counted a non-image");
  assert.equal(first.pinned, 2);
  assert.equal(first.failed, 0);

  const second = await backfill(db, store, pinner);
  assert.equal(second.considered, 0, "re-pinned something already pinned");
});

test("backfill honours its batch limit", opts, async () => {
  // Each click pins a bounded batch, so a request cannot outlive a proxy.
  await reset();
  const store = createPgStore({ db });
  for (let i = 0; i < 5; i++) {
    await store.putFile({ path: `src/assets/images/${i}.png`, content: Buffer.from([i, i, i]) });
  }
  const result = await backfill(db, store, stubPinner(), { limit: 2 });
  assert.ok(result.considered <= 2, `pinned ${result.considered} with a limit of 2`);
});

test("status counts images, not documents", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  await store.putFile({ path: "src/assets/images/a.png", content: Buffer.from([1]) });
  await store.putFile({ path: "src/assets/images/b.svg", content: Buffer.from([2]) });
  await store.putFile({ path: "src/_data/site.json", content: "{}" });
  await store.putFile({ path: "src/assets/images/notes.pdf", content: Buffer.from([3]) });

  const before = await pinStatus(db);
  assert.equal(before.images, 2, "counted a data file or a pdf as an image");
  assert.equal(before.pinned, 0);
  assert.equal(before.unpinned, 2);

  await backfill(db, store, stubPinner());
  const after = await pinStatus(db);
  assert.equal(after.pinned, 2);
  assert.equal(after.unpinned, 0);
});

test("pins list with their paths and CIDs", opts, async () => {
  await reset();
  const store = createPgStore({ db });
  await store.putFile({ path: "src/assets/images/lmax.png", content: Buffer.from([1, 2, 3]) });
  await backfill(db, store, stubPinner());

  const pins = await listPins(db);
  assert.equal(pins.length, 1);
  assert.equal(pins[0].path, "src/assets/images/lmax.png");
  assert.match(pins[0].cid, /^bafy/);
});

test("recording a pin twice updates rather than failing", opts, async () => {
  await reset();
  await recordPin(db, { digest: "d1", cid: "bafy1", bytes: 10, filename: "a.png" });
  await recordPin(db, { digest: "d1", cid: "bafy2", bytes: 20, filename: "a.png" });
  assert.equal(await findCid(db, "d1"), "bafy2");
});
