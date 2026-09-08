import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createPgSessions } from "../admin/session-store.js";

/**
 * Sessions have to survive a restart.
 *
 * They did not, and the consequence was visible: the navigation showed an
 * "Admin" link from a readable cookie that outlived the server, so after
 * every deploy the menu said you were signed in and the first click sent you
 * to the sign-in page.
 *
 * A second store instance over the same database is exactly what a restart
 * looks like from the session's point of view.
 */
const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run these" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests truncate tables." }
    : {};

let db;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
});

after(async () => {
  if (db) await db.end();
});

const reset = () => db.query("truncate sessions");

test("a session outlives the process that created it", opts, async () => {
  await reset();
  const before = createPgSessions({ db, kind: "admin" });
  const id = await before.create({ email: "chris@onchainlabs.ch" }, null);

  // A fresh store over the same database: what the next boot sees.
  const after = createPgSessions({ db, kind: "admin" });
  const session = await after.get(id);

  assert.ok(session, "the session did not survive a restart");
  assert.equal(session.user.email, "chris@onchainlabs.ch");
});

test("an admin session is invisible to the portal, and the reverse", opts, async () => {
  // One table, two populations. Signing out of one must not reach the other,
  // and neither may read the other's sessions.
  await reset();
  const admins = createPgSessions({ db, kind: "admin" });
  const guests = createPgSessions({ db, kind: "guest" });

  const adminId = await admins.create({ email: "chris@onchainlabs.ch" }, null);
  const guestId = await guests.create({ id: 1, email: "ada@example.com" }, null);

  assert.equal(await guests.get(adminId), undefined, "the portal could read an admin session");
  assert.equal(await admins.get(guestId), undefined, "the admin could read a guest session");
  assert.ok(await admins.get(adminId));
  assert.ok(await guests.get(guestId));
});

test("signing out destroys only that session", opts, async () => {
  await reset();
  const sessions = createPgSessions({ db, kind: "guest" });
  const first = await sessions.create({ id: 1, email: "ada@example.com" }, null);
  const second = await sessions.create({ id: 1, email: "ada@example.com" }, null);

  await sessions.destroy(first);
  assert.equal(await sessions.get(first), undefined);
  assert.ok(await sessions.get(second), "signing out took another session with it");
});

test("changing a password ends the account's other sessions", opts, async () => {
  // If the password was changed because it leaked, leaving them alive defeats
  // the point.
  await reset();
  const sessions = createPgSessions({ db, kind: "guest" });
  const keep = await sessions.create({ id: 1, email: "Ada@Example.com" }, null);
  const other = await sessions.create({ id: 1, email: "ada@example.com" }, null);
  const someoneElse = await sessions.create({ id: 2, email: "grace@example.com" }, null);

  const ended = await sessions.destroyOthersFor("ada@example.com", keep);

  assert.equal(ended, 1);
  assert.ok(await sessions.get(keep), "the current session was signed out");
  assert.equal(await sessions.get(other), undefined, "another session for the account survived");
  assert.ok(await sessions.get(someoneElse), "somebody else was signed out");
});

test("an expired session is not honoured", opts, async () => {
  await reset();
  const sessions = createPgSessions({ db, kind: "admin", ttlMs: -1000 });
  const id = await sessions.create({ email: "chris@onchainlabs.ch" }, null);
  assert.equal(await sessions.get(id), undefined);
});

test("an unknown or malformed id is simply not a session", opts, async () => {
  await reset();
  const sessions = createPgSessions({ db, kind: "admin" });
  for (const id of ["", null, undefined, "not-a-real-id", "'; drop table sessions; --"]) {
    assert.equal(await sessions.get(id), undefined, String(id));
  }
  // And the table is still there.
  assert.equal(await sessions.size(), 0);
});

test("expired rows are swept, not left to accumulate", opts, async () => {
  await reset();
  const stale = createPgSessions({ db, kind: "guest", ttlMs: -1000 });
  await stale.create({ id: 1, email: "ada@example.com" }, null);
  assert.equal((await db.query("select count(*)::int n from sessions")).rows[0].n, 1);

  // A later create sweeps what has expired.
  const fresh = createPgSessions({ db, kind: "guest" });
  await fresh.create({ id: 2, email: "grace@example.com" }, null);
  await new Promise((r) => setTimeout(r, 250));

  const { rows } = await db.query("select count(*)::int n from sessions");
  assert.equal(rows[0].n, 1, "the expired row was not swept");
});
