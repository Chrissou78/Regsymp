import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createEvents } from "../admin/events.js";
import { createInterest, validateInterest } from "../admin/the-33.js";
import { interestCsv } from "../admin/interest-page.js";

/**
 * The 33.
 *
 * A registration of interest, and deliberately nothing more: no seat is held,
 * no badge is issued, nothing is charged. The tests that matter are the ones
 * that keep it that way, and the ones that stop the form being a way to put
 * arbitrary text in front of the programme chairs.
 */

// ------------------------------------------------------------ the validator

const good = {
  name: "Ada Lovelace",
  email: "Ada@Example.com",
  company: "Engines",
  editions: ["London — November 2026"],
  startedAt: String(Date.now() - 10_000)
};

test("a complete submission is accepted, and tidied", () => {
  const checked = validateInterest(good);
  assert.equal(checked.ok, true);
  assert.equal(checked.data.name, "Ada Lovelace");
  // Lowercased, because it is what a person will be looked up by later.
  assert.equal(checked.data.email, "ada@example.com");
  assert.deepEqual(checked.data.editions, ["London — November 2026"]);
});

test("a name, an address and a company are all required", () => {
  for (const missing of ["name", "email", "company"]) {
    const checked = validateInterest({ ...good, [missing]: "  " });
    assert.equal(checked.ok, false, `${missing} was optional`);
  }
  assert.equal(validateInterest({ ...good, email: "not-an-address" }).ok, false);
});

test("at least one edition, because otherwise there is nothing to be interested in", () => {
  assert.equal(validateInterest({ ...good, editions: [] }).ok, false);
  assert.equal(validateInterest({ ...good, editions: undefined }).ok, false);
});

test("one ticked box arrives as a string, and is still one edition", () => {
  // A checkbox group posts a single value when one is ticked and an array
  // when several are. Treating the string as a list gives six single letters.
  const checked = validateInterest({ ...good, editions: "Davos — January 2027" });
  assert.deepEqual(checked.data.editions, ["Davos — January 2027"]);
});

test("the same edition twice is once", () => {
  const checked = validateInterest({
    ...good,
    editions: ["London — November 2026", "London — November 2026"]
  });
  assert.deepEqual(checked.data.editions, ["London — November 2026"]);
});

test("only editions the site is announcing", () => {
  // Whatever arrives has been through a browser, and this list is read by a
  // person in an email. Anything invented is dropped.
  const offered = ["London — November 2026", "Davos — January 2027"];
  const checked = validateInterest(
    { ...good, editions: ["Davos — January 2027", "Atlantis — whenever"] },
    { editions: offered }
  );
  assert.deepEqual(checked.data.editions, ["Davos — January 2027"]);

  const none = validateInterest({ ...good, editions: ["Atlantis — whenever"] }, { editions: offered });
  assert.equal(none.ok, false);
});

test("the honeypot and the clock are both refused, and say nothing useful", () => {
  const trapped = validateInterest({ ...good, website: "http://spam.example" });
  assert.equal(trapped.ok, false);
  assert.equal(trapped.error, "Rejected.");

  const rushed = validateInterest({ ...good, startedAt: String(Date.now() - 200) });
  assert.equal(rushed.ok, false);
  assert.equal(rushed.error, "Rejected.");
});

test("a missing clock is not treated as an instant submission", () => {
  // The timestamp is set by script. Somebody with no JavaScript still has a
  // working form, and must not be turned away for it.
  assert.equal(validateInterest({ ...good, startedAt: undefined }).ok, true);
  assert.equal(validateInterest({ ...good, startedAt: "" }).ok, true);
});

test("a very long note is cut rather than refused", () => {
  const checked = validateInterest({ ...good, note: "x".repeat(9000) });
  assert.equal(checked.ok, true);
  assert.equal(checked.data.note.length, 2000);
});

// ------------------------------------------------------------------- the csv

test("the csv quotes what a spreadsheet would otherwise misread", () => {
  const csv = interestCsv([
    {
      name: 'Ada "The Engine" Lovelace',
      email: "ada@example.com",
      company: "Babbage, Lovelace & Co",
      editions: ["London — November 2026", "Davos — January 2027"],
      note: null,
      status: "new",
      createdAt: "2026-09-23T10:00:00.000Z"
    }
  ]);
  assert.match(csv, /^﻿/, "Excel needs the BOM to read it as UTF-8");
  assert.match(csv, /"Ada ""The Engine"" Lovelace"/);
  assert.match(csv, /"Babbage, Lovelace & Co"/);
  assert.match(csv, /"London — November 2026; Davos — January 2027"/);
});

test("a cell that looks like a formula is defused", () => {
  // A company called "=cmd|..." is a spreadsheet injection, and this file is
  // going to be opened by somebody in Excel.
  const csv = interestCsv([
    {
      name: "=1+1",
      email: "x@example.com",
      company: "@SUM(A1)",
      editions: [],
      status: "new",
      createdAt: null
    }
  ]);
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"'@SUM\(A1\)"/);
});

// ----------------------------------------------------------------- the store

const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run these" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests truncate tables." }
    : {};

let db;
let interest;
let events;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  interest = createInterest({ db });
  events = createEvents({ db });
});

after(async () => {
  if (db) await db.end();
});

const reset = () => db.query("truncate the33_interest");

const asking = (over = {}) =>
  interest.record({
    name: "Ada Lovelace",
    email: "ada@example.com",
    company: "Engines",
    editions: ["London — November 2026"],
    ...over
  });

test("somebody asking is recorded, and starts as new", opts, async () => {
  await reset();
  const asked = await asking();
  assert.equal(asked.status, "new");
  assert.deepEqual(asked.editions, ["London — November 2026"]);
  assert.equal((await interest.list()).length, 1);
});

test("the same person can ask twice, because they may change their mind", opts, async () => {
  await reset();
  await asking({ editions: ["London — November 2026"] });
  await asking({ editions: ["Davos — January 2027"] });
  assert.equal(await interest.count(), 2);
});

test("demand is counted per edition, which is the only figure anybody asks for", opts, async () => {
  await reset();
  await asking({ editions: ["London — November 2026", "Davos — January 2027"] });
  await asking({ email: "b@example.com", editions: ["Davos — January 2027"] });

  const demand = await interest.demand();
  assert.deepEqual(demand[0], { edition: "Davos — January 2027", wanted: 2 });
  assert.deepEqual(demand[1], { edition: "London — November 2026", wanted: 1 });
});

test("an archived registration stops counting towards demand", opts, async () => {
  await reset();
  const one = await asking();
  await interest.setStatus(one.id, "archived", "chris@onchainlabs.ch");
  assert.deepEqual(await interest.demand(), []);
});

test("the list can be narrowed to one edition", opts, async () => {
  await reset();
  await asking({ editions: ["London — November 2026"] });
  await asking({ email: "b@example.com", editions: ["Davos — January 2027"] });

  assert.equal((await interest.list({ edition: "Davos — January 2027" })).length, 1);
  assert.equal((await interest.list({ edition: "Napa Valley — Spring 2027" })).length, 0);
});

test("marking somebody invited records who decided, and when", opts, async () => {
  await reset();
  const one = await asking();
  const after = await interest.setStatus(one.id, "invited", "chris@onchainlabs.ch");
  assert.equal(after.status, "invited");
  assert.equal(after.handledBy, "chris@onchainlabs.ch");
  assert.ok(after.handledAt);
});

test("a status that is not one is refused", opts, async () => {
  await reset();
  const one = await asking();
  await assert.rejects(() => interest.setStatus(one.id, "seated", "chris"), /not a status/);
});

test("registering interest issues nothing", opts, async () => {
  await reset();
  // Counted as a difference rather than against zero: these tests share a
  // database with the ones that do issue badges.
  const tally = async () =>
    (
      await db.query(
        `select (select count(*) from attendees)::int as people,
                (select count(*) from tickets)::int as badges`
      )
    ).rows[0];

  const before = await tally();
  await asking();
  // The whole point. An invitation to a private dinner is a letter from a
  // person, and nothing here should have quietly become an admission.
  assert.deepEqual(await tally(), before);
});

test("the editions offered are the ones the site announces", opts, async () => {
  // What the endpoint validates against, built the same way the page builds
  // the chips -- if these two ever disagree, every submission is refused.
  if (!(await events.upcoming()).length) return;
  const announced = await events.upcoming();
  const offered = announced.map((e) => `${e.city || e.name} — ${e.whenLabel}`);
  assert.ok(offered.every((o) => o.includes(" — ")));
  assert.equal(validateInterest({ ...good, editions: [offered[0]] }, { editions: offered }).ok, true);
});

// -------------------------------------------------- swapping a photograph

test("where a photograph is stored and what the page calls it agree", async () => {
  // These are two different strings that have to line up: one is a path on
  // disk, the other is what goes in the markup under /assets/images/. Derived
  // separately on purpose, so this is the test that keeps them together.
  const { THE_33_DIR, the33Path } = await import("../admin/routes.js");
  assert.equal(THE_33_DIR, `src/assets/images/${the33Path("x").replace("/x", "")}`);
  assert.equal(the33Path("london-2026.jpg"), "the33/london-2026.jpg");
});

test("the event form offers an upload, and shows what is already there", async () => {
  const { eventPage } = await import("../admin/events-page.js");
  const html = eventPage({
    event: {
      slug: "london-2026",
      name: "The 33 · London",
      status: "draft",
      whenLabel: "November 2026",
      upcoming: true,
      sort: 0,
      imagePath: "the33/london-2026.jpg"
    },
    seats: [],
    stripeReady: true,
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "tok"
  });

  // Without the enctype the file never leaves the browser and the save looks
  // like it worked.
  assert.match(html, /enctype="multipart\/form-data"/);
  assert.match(html, /name="photo" type="file"/);
  assert.match(html, /src="\/assets\/images\/the33\/london-2026\.jpg"/);
});

test("an event with no photograph yet is still editable", async () => {
  const { eventPage } = await import("../admin/events-page.js");
  const html = eventPage({
    event: { slug: "new-2028", name: "Somewhere", status: "draft", whenLabel: "One day", sort: 0 },
    seats: [],
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "tok"
  });
  assert.match(html, /name="photo" type="file"/);
  assert.doesNotMatch(html, /a-thumb/, "a thumbnail of nothing is a broken image");
});
