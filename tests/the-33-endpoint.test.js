import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { keepingGenerated } from "./helpers/generated.js";

/**
 * Registering interest, over HTTP against the real server.
 *
 * The endpoint is booted with a database so the row can be read back, and the
 * mailer is left unconfigured on purpose: the chairs being told is the second
 * thing that happens, and the row surviving without it is the first.
 */

const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run these" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests truncate tables." }
    : {};

// Never a real .env, and never a real key: this boots the actual server.
process.env.SKIP_ENV_FILE = "1";
for (const name of ["RESEND_API_KEY", "RESEND_FROM", "PINATA_JWT", "WALLETWALLET_API_KEY"]) {
  delete process.env[name];
}
process.env.DATABASE_URL = URL ?? "";

let server;
let db;
let base;
let offered = [];
// Booting the server rewrites what the site is built from. Held here and put
// back once, rather than around each test.
let restore = null;
let finished = null;

before(async () => {
  if (!URL || unsafe) return;

  db = createDb({ url: URL });
  await migrate(db);

  // The chips the page renders, built the same way the endpoint validates
  // against them -- if these ever disagree, every submission is refused.
  const { rows } = await db.query(
    `select coalesce(city, name) as place, when_label
       from events where upcoming and status <> 'past'
       order by sort, starts_on nulls last, name`
  );
  offered = rows.map((r) => `${r.place} — ${r.when_label}`);

  // Held open for the whole file: the import is what writes, and it happens
  // once. `restore` closes it in `after`.
  const held = new Promise((resolve) => {
    finished = resolve;
  });
  restore = keepingGenerated(() => held);

  ({ server } = await import("../server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.end();
  finished?.();
  await restore;
});

const reset = () => db.query("truncate the33_interest");

const send = (body, init = {}) =>
  fetch(`${base}/api/the-33`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init
  });

const asking = (over = {}) => ({
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Engines",
  editions: [offered[0]],
  startedAt: String(Date.now() - 10_000),
  ...over
});

test("a registration is taken and stored", opts, async () => {
  await reset();
  const res = await send(asking());
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).editions, [offered[0]]);

  const { rows } = await db.query("select * from the33_interest");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "ada@example.com");
  assert.equal(rows[0].status, "new");
  assert.deepEqual(rows[0].editions, [offered[0]]);
  assert.equal(rows[0].source, null);
});

test("the source is kept, so a card click is not a link somebody was sent", opts, async () => {
  await reset();
  await send(asking({ source: "the-33" }));
  const { rows } = await db.query("select source from the33_interest");
  assert.equal(rows[0].source, "the-33");
});

test("an edition nobody is running is not recorded", opts, async () => {
  await reset();
  const res = await send(asking({ editions: ["Atlantis — whenever"] }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at least one edition/);
  assert.equal((await db.query("select 1 from the33_interest")).rows.length, 0);
});

test("a bad submission says what is wrong and stores nothing", opts, async () => {
  await reset();
  for (const [body, expected] of [
    [asking({ name: "" }), /your name/],
    [asking({ email: "nope" }), /email/],
    [asking({ company: "" }), /company/],
    [asking({ editions: [] }), /edition/]
  ]) {
    const res = await send(body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, expected);
  }
  assert.equal((await db.query("select 1 from the33_interest")).rows.length, 0);
});

test("the honeypot is refused without saying why", opts, async () => {
  await reset();
  const res = await send(asking({ website: "http://spam.example" }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "Rejected.");
  assert.equal((await db.query("select 1 from the33_interest")).rows.length, 0);
});

test("a form post works too, and lands back on the page", opts, async () => {
  // The same form, for somebody whose JavaScript did not run. Without this the
  // page looks fine and silently does nothing for them.
  await reset();
  const body = new URLSearchParams({
    name: "Ada Lovelace",
    email: "ada@example.com",
    company: "Engines",
    startedAt: String(Date.now() - 10_000)
  });
  body.append("editions", offered[0]);
  body.append("editions", offered[1]);

  const res = await fetch(`${base}/api/the-33`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^\/next\//);

  const { rows } = await db.query("select editions from the33_interest");
  assert.deepEqual(rows[0].editions, [offered[0], offered[1]]);
});

test("only POST", opts, async () => {
  const res = await fetch(`${base}/api/the-33`);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("registering interest creates no attendee and no badge", opts, async () => {
  await reset();
  const tally = async () =>
    (
      await db.query(
        `select (select count(*) from attendees)::int as people,
                (select count(*) from tickets)::int as badges`
      )
    ).rows[0];

  const before = await tally();
  assert.equal((await send(asking())).status, 200);
  // The whole point: it is a registration of interest, not an admission.
  assert.deepEqual(await tally(), before);
});
