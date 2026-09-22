import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createEvents } from "../admin/events.js";

/**
 * Events.
 *
 * The site is about one at a time. That is enforced by a partial unique index
 * rather than by whoever remembers, because "two events are live" is a state
 * with no sensible rendering -- and the rule has to hold for a script as well
 * as for the button.
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
let events;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  events = createEvents({ db });
});

after(async () => {
  if (db) await db.end();
});

const reset = () => db.query("truncate events");

const draft = (slug, fields = {}) =>
  events.create({ slug, name: slug, whenLabel: "Spring 2027", ...fields }, "a test");

// ------------------------------------------------------------------ writing

test("an event starts as a draft, so adding one changes nothing", opts, async () => {
  await reset();
  const made = await draft("london-2026", { name: "The 33 · London", city: "London" });
  assert.equal(made.status, "draft");
  assert.equal(await events.live(), null, "adding an event made the site about it");
});

test("when it is can be said loosely, because that is often the truth", opts, async () => {
  await reset();
  const made = await draft("napa-2027", { whenLabel: "Spring 2027" });
  assert.equal(made.whenLabel, "Spring 2027");
  assert.equal(made.startsOn, null);
});

test("an event needs a name and a when", opts, async () => {
  await reset();
  await assert.rejects(() => events.create({ slug: "x", whenLabel: "Spring" }, "t"), /a name/);
  await assert.rejects(() => events.create({ slug: "x", name: "X" }, "t"), /when it is/);
  for (const slug of ["", "Has Space", "-leading", "trailing-", "Ünïcode"]) {
    await assert.rejects(() => events.create({ slug, name: "X", whenLabel: "W" }, "t"), /identifier/);
  }

  // Case is normalised rather than refused: somebody typing London-2026 means
  // the same thing as london-2026, and telling them off for it helps nobody.
  const made = await events.create({ slug: "London-2026", name: "X", whenLabel: "W" }, "t");
  assert.equal(made.slug, "london-2026");
});

test("a date has to be a date", opts, async () => {
  await reset();
  await assert.rejects(() => draft("bad", { startsOn: "next spring" }), /written as 2027-01-19/);
});

test("the same identifier twice is refused clearly", opts, async () => {
  await reset();
  await draft("davos-2027");
  await assert.rejects(() => draft("davos-2027"), /already an event/);
});

// ------------------------------------------------------------- one at a time

test("making one live stands the previous one down", opts, async () => {
  await reset();
  await draft("palma-2026");
  await draft("london-2026");

  await events.activate("palma-2026");
  assert.equal((await events.live()).slug, "palma-2026");

  await events.activate("london-2026");
  const live = await events.live();
  assert.equal(live.slug, "london-2026");
  assert.equal((await events.bySlug("palma-2026")).status, "past", "the old one is still live");
});

test("the database refuses two live events, whatever the code does", opts, async () => {
  // Straight SQL, bypassing activate() entirely: this is the guarantee.
  await reset();
  await draft("one");
  await draft("two");
  await events.activate("one");

  await assert.rejects(
    () => db.query("update events set status = 'live' where slug = 'two'"),
    /events_one_live/
  );
});

test("the live event cannot be removed by accident", opts, async () => {
  await reset();
  await draft("live-one");
  await events.activate("live-one");
  await assert.rejects(() => events.remove("live-one"), /cannot be removed/);

  await draft("draft-one");
  assert.equal(await events.remove("draft-one"), "draft-one");
});

test("the site can have no event at all", opts, async () => {
  // Between events, which is what sleep mode is for.
  await reset();
  await draft("only");
  await events.activate("only");
  await events.standDown("only");
  assert.equal(await events.live(), null);
});

// ------------------------------------------------------- what the site reads

test("coming next lists the drafts, in the order given, without the live one", opts, async () => {
  await reset();
  await draft("palma", { name: "Palma", sort: 0, upcoming: false });
  await draft("davos", { name: "Davos", sort: 2 });
  await draft("london", { name: "London", sort: 1 });
  await draft("napa", { name: "Napa", sort: 3 });
  await events.activate("palma");

  const data = await events.toData();
  assert.equal(data.live.slug, "palma");
  assert.deepEqual(
    data.upcoming.map((e) => e.slug),
    ["london", "davos", "napa"],
    "the order or the contents are wrong"
  );
});

test("an event can exist without being announced", opts, async () => {
  // Not every event that exists is one to put on the homepage.
  await reset();
  await draft("quiet", { upcoming: false });
  await draft("loud", { upcoming: true });

  const data = await events.toData();
  assert.deepEqual(data.upcoming.map((e) => e.slug), ["loud"]);
  assert.equal(data.all.length, 2, "it should still be in the admin");
});

test("a past event drops out of coming next", opts, async () => {
  await reset();
  await draft("done");
  await events.activate("done");
  await events.standDown("done");

  const data = await events.toData();
  assert.deepEqual(data.upcoming, []);
});

test("editing an event does not disturb the others", opts, async () => {
  await reset();
  await draft("a", { name: "A", tagline: "first" });
  await draft("b", { name: "B", tagline: "second" });

  await events.update("a", { tagline: "changed", city: "London" });

  assert.equal((await events.bySlug("a")).tagline, "changed");
  assert.equal((await events.bySlug("a")).city, "London");
  assert.equal((await events.bySlug("b")).tagline, "second");
});
