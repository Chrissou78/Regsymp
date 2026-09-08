import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createBadgeCategories } from "../admin/badge-categories.js";
import { createAttendees } from "../admin/attendees.js";

/**
 * Badge categories are data now, so the organisers can add Press or Staff
 * without a migration. The rule that mattered -- a number belongs to exactly
 * one category's range -- had to survive that, and it did: a CHECK cannot
 * read another table, so a trigger enforces it.
 *
 * These need a real Postgres, because the trigger is the thing under test.
 *
 * The suite runs its files one at a time (--test-concurrency=1). Several of
 * them truncate the same tables, and in parallel they deleted each other's
 * rows mid-test -- eleven failures that every file passed alone.
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
let categories;
let attendees;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  categories = createBadgeCategories({ db });
  attendees = createAttendees({ db });
});

after(async () => {
  if (db) await db.end();
});

/** The three built-in categories, at their original ranges, and no guests. */
async function reset() {
  await db.query("truncate attendees cascade");
  await db.query("delete from badge_categories where not protected");
  await db.query("update badge_categories set number_from = 1, number_to = 33 where slug = 'vip'");
  await db.query("update badge_categories set number_from = 34, number_to = 100 where slug = 'visitor'");
  await db.query(
    "update badge_categories set number_from = null, number_to = null where slug = 'speaker'"
  );
}

const guest = async (email, role = "visitor") =>
  attendees.create({ email, role }, "chris@onchainlabs.ch");

// ------------------------------------------------------------------ the three

test("the event ships with speaker, VIP and visitor", opts, async () => {
  await reset();
  const list = await categories.list();
  assert.deepEqual(
    list.map((c) => c.slug),
    ["speaker", "vip", "visitor"]
  );
  assert.equal(list.find((c) => c.slug === "vip").limit, 33);
  assert.equal(list.find((c) => c.slug === "visitor").limit, 67);
  assert.equal(list.find((c) => c.slug === "speaker").numbered, false);
});

test("the built-in three cannot be removed, only edited", opts, async () => {
  // Removing one would strand its badges and break the speaker portal.
  await reset();
  for (const slug of ["speaker", "vip", "visitor"]) {
    await assert.rejects(() => categories.remove(slug), /cannot be removed/);
  }
  const renamed = await categories.update("visitor", {
    label: "Delegate",
    from: 34,
    to: 100,
    colour: "#6B7FA0"
  });
  assert.equal(renamed.label, "Delegate");
});

// ------------------------------------------------------------------- adding

test("a category can be added with its own block of numbers", opts, async () => {
  await reset();
  const press = await categories.create({
    slug: "press",
    label: "Press",
    from: 200,
    to: 220,
    colour: "7A5E22"
  });
  assert.equal(press.limit, 21);
  assert.equal(press.colour, "#7A5E22", "the colour should be normalised to #RRGGBB");
});

test("overlapping ranges are refused", opts, async () => {
  // Two categories drawing from the same numbers would hand two people the
  // same badge number, and the symptom would appear much later as an
  // inexplicable "none left".
  await reset();
  await assert.rejects(
    () => categories.create({ slug: "staff", label: "Staff", from: 30, to: 50 }),
    /overlap VIP/
  );
  await assert.rejects(
    () => categories.create({ slug: "staff", label: "Staff", from: 90, to: 120 }),
    /overlap/
  );
  await categories.create({ slug: "staff", label: "Staff", from: 101, to: 120 });
});

test("a range needs both ends, the right way round", opts, async () => {
  await reset();
  await assert.rejects(() => categories.create({ slug: "aa", label: "A", from: 5 }), /first and a last/);
  await assert.rejects(() => categories.create({ slug: "aa", label: "A", to: 5 }), /first and a last/);
  await assert.rejects(
    () => categories.create({ slug: "aa", label: "A", from: 200, to: 150 }),
    /must not be after/
  );
});

test("an identifier has to be usable in a URL", opts, async () => {
  await reset();
  for (const slug of ["", "A", "has space", "Ünïcode", "-leading"]) {
    await assert.rejects(() => categories.create({ slug, label: "X" }), /identifier/);
  }
  await categories.create({ slug: "side-stage", label: "Side stage" });
});

test("a duplicate identifier is refused clearly", opts, async () => {
  await reset();
  await assert.rejects(() => categories.create({ slug: "vip", label: "Another VIP" }), /already/);
});

// ------------------------------------------------------------------ issuing

test("an unnumbered category issues badges without a number", opts, async () => {
  // Which is how Speaker starts: a badge saying what somebody is rather than
  // where they sit in a count.
  await reset();
  const speaker = await guest("speaker@example.com", "speaker");
  await attendees.issueTicket({ attendeeId: speaker.id, category: "speaker", issuedBy: "chris" });

  const ticket = await attendees.ticketFor(speaker.id);
  assert.equal(ticket.number, null);
  assert.equal(ticket.label, "Speaker", "an unnumbered badge should name its category");
  assert.equal(ticket.colour, "#B8963A");
});

test("numbered categories start at the first number in their range", opts, async () => {
  await reset();
  const vip = await guest("vip@example.com");
  const visitor = await guest("visitor@example.com");

  await attendees.issueTicket({ attendeeId: vip.id, category: "vip", issuedBy: "chris" });
  await attendees.issueTicket({ attendeeId: visitor.id, category: "visitor", issuedBy: "chris" });

  assert.equal((await attendees.ticketFor(vip.id)).label, "1/33");
  assert.equal((await attendees.ticketFor(visitor.id)).label, "34/100");
});

test("a category that is full says so", opts, async () => {
  await reset();
  await categories.create({ slug: "tiny", label: "Tiny", from: 500, to: 501 });

  for (const email of ["a@example.com", "b@example.com"]) {
    const who = await guest(email);
    await attendees.issueTicket({ attendeeId: who.id, category: "tiny", issuedBy: "chris" });
  }

  const third = await guest("c@example.com");
  await assert.rejects(
    () => attendees.issueTicket({ attendeeId: third.id, category: "tiny", issuedBy: "chris" }),
    /No Tiny badges left/
  );
});

// ------------------------------------------------------- the rule, in the db

test("the database refuses a number outside its category", opts, async () => {
  // Straight SQL, bypassing the allocator entirely: this is the guarantee.
  await reset();
  const who = await guest("t@example.com");
  const put = (number, category) =>
    db.query("insert into tickets (attendee_id, number, category, code) values ($1,$2,$3,$4)", [
      who.id,
      number,
      category,
      `code-${number}-${category}`
    ]);

  await assert.rejects(() => put(34, "vip"), /outside the vip range/);
  await assert.rejects(() => put(33, "visitor"), /outside the visitor range/);
  await assert.rejects(() => put(5, "speaker"), /unnumbered/);
  await assert.rejects(() => put(null, "vip"), /needs a number/);
  await assert.rejects(() => put(1, "nonexistent"), /unknown badge category/);
  await put(1, "vip"); // and the valid one goes in
});

test("one number is never issued twice, across categories", opts, async () => {
  await reset();
  await db.query(
    "update badge_categories set number_from = 1, number_to = 40 where slug = 'speaker'"
  );

  const a = await guest("a@example.com", "speaker");
  const b = await guest("b@example.com");
  await attendees.issueTicket({ attendeeId: a.id, category: "speaker", issuedBy: "chris" });
  await attendees.issueTicket({ attendeeId: b.id, category: "vip", issuedBy: "chris" });

  const first = (await attendees.ticketFor(a.id)).number;
  const second = (await attendees.ticketFor(b.id)).number;
  assert.notEqual(first, second, "two categories sharing a range handed out the same number");
});

test("the trigger follows a category that has been edited", opts, async () => {
  await reset();
  await categories.update("speaker", { label: "Speaker", from: 500, to: 540, colour: "#B8963A" });

  const who = await guest("s@example.com", "speaker");
  await attendees.issueTicket({ attendeeId: who.id, category: "speaker", issuedBy: "chris" });
  assert.equal((await attendees.ticketFor(who.id)).number, 500);
});

// ------------------------------------------------------------------ editing

test("a range cannot shrink under badges already issued", opts, async () => {
  // Otherwise rows the trigger now considers invalid sit there silently until
  // some later edit fails for a reason nobody can see.
  await reset();
  const who = await guest("v@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "visitor", issuedBy: "chris" });

  await assert.rejects(
    () => categories.update("visitor", { label: "Visitor", from: 50, to: 100 }),
    /fall outside/
  );
  await assert.rejects(
    () => categories.update("visitor", { label: "Visitor", from: null, to: null }),
    /carry numbers/
  );
});

test("a category cannot be removed once it has been used", opts, async () => {
  // Withdrawing does not undo it: the badge row still points at the category,
  // so the foreign key would refuse the delete however it were counted.
  await reset();
  await categories.create({ slug: "press", label: "Press", from: 200, to: 210 });
  const who = await guest("p@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "press", issuedBy: "chris" });

  await assert.rejects(() => categories.remove("press"), /cannot be removed once it has been used/);

  await attendees.revokeTicket((await attendees.ticketFor(who.id)).id);
  await assert.rejects(() => categories.remove("press"), /including any withdrawn/);
});

test("an unused category can be removed", opts, async () => {
  await reset();
  await categories.create({ slug: "staff", label: "Staff", from: 300, to: 310 });
  await categories.remove("staff");
  assert.equal(await categories.byslug("staff"), null);
});

test("capacity is reported per category", opts, async () => {
  await reset();
  for (const [email, category] of [
    ["a@example.com", "vip"],
    ["b@example.com", "visitor"],
    ["c@example.com", "speaker"]
  ]) {
    const who = await guest(email, category === "speaker" ? "speaker" : "visitor");
    await attendees.issueTicket({ attendeeId: who.id, category, issuedBy: "chris" });
  }

  const by = Object.fromEntries((await attendees.capacity()).map((c) => [c.category, c]));
  assert.equal(by.vip.issued, 1);
  assert.equal(by.vip.limit, 33);
  assert.equal(by.visitor.limit, 67);
  assert.equal(by.speaker.numbered, false);
  assert.equal(by.speaker.limit, null, "an unnumbered category has no limit");
});

test("a withdrawn number is never reissued", opts, async () => {
  // Deliberate. A printed badge carrying #1 may still be in somebody's
  // pocket, so handing #1 to the next person would put two of them in the
  // room. The next badge takes the next number instead.
  await reset();
  const first = await guest("first@example.com");
  await attendees.issueTicket({ attendeeId: first.id, category: "vip", issuedBy: "chris" });
  const withdrawn = await attendees.ticketFor(first.id);
  assert.equal(withdrawn.number, 1);

  await attendees.revokeTicket(withdrawn.id);
  assert.equal(await attendees.ticketFor(first.id), null, "the badge is still active");

  const second = await guest("second@example.com");
  await attendees.issueTicket({ attendeeId: second.id, category: "vip", issuedBy: "chris" });
  assert.equal(
    (await attendees.ticketFor(second.id)).number,
    2,
    "a withdrawn number was handed out again"
  );
});
