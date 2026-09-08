import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createBadgeCategories } from "../admin/badge-categories.js";
import { createAttendees } from "../admin/attendees.js";
import { attendeesPage, EXAMPLE_CSV } from "../admin/attendees-page.js";
import { parseAttendees } from "../admin/import-attendees.js";

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
  await db.query(
    "update badge_categories set number_from = 1, number_to = 33, label = 'VIP' where slug = 'vip'"
  );
  await db.query(
    "update badge_categories set number_from = 34, number_to = 100, label = 'Visitor' where slug = 'visitor'"
  );
  await db.query(
    "update badge_categories set number_from = null, number_to = null, label = 'Speaker' where slug = 'speaker'"
  );
}

const guest = async (email, category = "visitor") =>
  attendees.create({ email, category }, "chris@onchainlabs.ch");

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

// ---------------------------------------------------------- the guest list

test("every badge type the guest list offers can actually be issued", opts, async () => {
  // The list was hardcoded to "general" and "vip", posted as a field called
  // tier that 008 had dropped. So the route read no category, Speaker was
  // absent, and every choice failed with "Choose a badge category."
  //
  // Asserting the two ends agree is the point: whatever the page offers has
  // to be something the store accepts.
  await reset();
  await categories.create({ slug: "press", label: "Press", from: 200, to: 210 });

  const who = await guest("offered@example.com");
  const page = attendeesPage({
    guests: await attendees.list(),
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });

  const form = page.match(/<select name="category"[\s\S]*?<\/select>/);
  assert.ok(form, "the guest list offers no badge category to choose from");

  const offered = [...form[0].matchAll(/<option value="([^"]*)"/g)]
    .map((m) => m[1])
    .filter(Boolean);

  assert.deepEqual(
    offered.sort(),
    (await categories.list()).map((c) => c.slug).sort(),
    "the list of badge types does not match the categories that exist"
  );

  // And each one really is issuable, which is what failed before.
  for (const slug of offered) {
    const someone = await attendees.create({ email: `${slug}@example.com`, category: slug }, "chris");
    await attendees.issueTicket({ attendeeId: someone.id, category: slug, issuedBy: "chris" });
  }

  assert.equal((await attendees.ticketFor(who.id)), null, "the sample guest should still hold nothing");
});

test("a full category cannot be picked for somebody new", opts, async () => {
  await reset();
  await categories.create({ slug: "tiny", label: "Tiny", from: 500, to: 500 });
  const first = await guest("first@example.com");
  await attendees.issueTicket({ attendeeId: first.id, category: "tiny", issuedBy: "chris" });

  const page = attendeesPage({
    guests: await attendees.list(),
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });

  assert.match(page, /<option value="tiny" disabled>Tiny — full<\/option>/);
  assert.match(page, /<option value="vip">VIP \(33 left\)<\/option>/);
});

test("the list is grouped by type, in the categories' own order", opts, async () => {
  // Read as "who are the speakers", not "who signed up on Tuesday".
  await reset();
  await guest("v1@example.com", "visitor");
  await guest("s1@example.com", "speaker");
  await guest("v2@example.com", "visitor");
  await guest("vip1@example.com", "vip");

  const page = attendeesPage({
    guests: await attendees.list(),
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });

  const headings = [...page.matchAll(/class="a-group-head">[\s\S]*?<\/span>\s*([^<]+)/g)].map(
    (m) => m[1].trim()
  );
  assert.deepEqual(headings, ["Speaker", "VIP", "Visitor"], "the groups are out of order");

  assert.equal((page.match(/class="a-group"/g) || []).length, 3);
  assert.equal((page.match(/class="a-guest"/g) || []).length, 4);
});

test("a claimed badge offers nothing to press; an unclaimed one offers Cancel", opts, async () => {
  await reset();
  const claimed = await guest("claimed@example.com", "vip");
  const open = await guest("open@example.com", "vip");
  await attendees.issueTicket({ attendeeId: claimed.id, category: "vip", issuedBy: "chris" });
  await attendees.issueTicket({ attendeeId: open.id, category: "vip", issuedBy: "chris" });
  await attendees.claimTicket((await attendees.ticketFor(claimed.id)).id);

  const page = attendeesPage({
    guests: await attendees.list(),
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });

  const rows = page.split('<li class="a-guest">').slice(1);
  const rowFor = (email) => rows.find((r) => r.includes(email));

  const settled = rowFor("claimed@example.com");
  assert.match(settled, /a-state--claimed">claimed</);
  assert.doesNotMatch(settled, /value="revoke"/, "a claimed badge could still be cancelled");

  const cancellable = rowFor("open@example.com");
  assert.match(cancellable, /a-state--unclaimed">not claimed</);
  assert.match(cancellable, /name="release" value="yes"/, "cancelling would not free the number");
  assert.match(cancellable, />Cancel</);
});

test("somebody with no badge is offered one in their own category", opts, async () => {
  // No selects and no number box: the account already says what they are.
  await reset();
  await guest("none@example.com", "vip");

  const page = attendeesPage({
    guests: await attendees.list(),
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });

  const row = page.split('<li class="a-guest">')[1];
  assert.match(row, /Attribute VIP badge/);
  assert.doesNotMatch(row, /name="number"/, "the number is chosen by hand again");
  assert.doesNotMatch(row, /<select name="category"/, "the row asks for a category again");
});

test("the paste box comes with an example file", opts, async () => {
  await reset();
  const page = attendeesPage({
    guests: [],
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });
  assert.match(page, /href="\/admin\/attendees\/example\.csv" download/);

  assert.equal(EXAMPLE_CSV.split("\n")[0], "Email,First name,Surname,Company,Position");
  // The example has to survive the parser it is an example for.
  const parsed = parseAttendees(EXAMPLE_CSV);
  assert.equal(parsed.problems.length, 0);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].email, "ada@example.com");
  assert.equal(parsed.rows[0].company, "Analytical Engines");
});

test("the type is asked once, when the account is made", opts, async () => {
  // Both places that create accounts ask, and neither assumes.
  await reset();
  const page = attendeesPage({
    guests: [],
    capacity: await attendees.capacity(),
    categories: await categories.list(),
    session: { user: { email: "chris@onchainlabs.ch" } },
    token: "t"
  });

  const selects = [...page.matchAll(/<select name="category"[\s\S]*?<\/select>/g)].map((m) => m[0]);
  assert.equal(selects.length, 2, "adding one person and adding several should both ask");
  for (const select of selects) {
    assert.match(select, /<option value="" selected disabled>/, "a type was chosen by default");
    assert.match(select, /value="speaker"/);
    assert.match(select, /value="vip"/);
    assert.match(select, /value="visitor"/);
  }
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

// ------------------------------------------------- claiming, and redistribution

test("a number freed before the badge is claimed goes to somebody else", opts, async () => {
  // The whole point: 33 VIP places, and a cancellation three weeks out should
  // not burn one of them.
  await reset();
  const cancels = await guest("cancels@example.com");
  await attendees.issueTicket({ attendeeId: cancels.id, category: "vip", issuedBy: "chris" });
  const badge = await attendees.ticketFor(cancels.id);
  assert.equal(badge.number, 1);

  await attendees.revokeTicket(badge.id, { release: true });

  const replacement = await guest("replacement@example.com");
  await attendees.issueTicket({ attendeeId: replacement.id, category: "vip", issuedBy: "chris" });
  assert.equal((await attendees.ticketFor(replacement.id)).number, 1, "number 1 was not reused");
});

test("a claimed badge keeps its number for good", opts, async () => {
  await reset();
  const who = await guest("claims@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris" });
  const badge = await attendees.ticketFor(who.id);

  await attendees.claimTicket(badge.id);

  await assert.rejects(
    () => attendees.revokeTicket(badge.id, { release: true }),
    /has been claimed/,
    "a claimed badge's number was put back in the pool"
  );

  // Withdrawing still works -- a place can be rescinded -- but the number
  // retires with it.
  await attendees.revokeTicket(badge.id);
  const next = await guest("next@example.com");
  await attendees.issueTicket({ attendeeId: next.id, category: "vip", issuedBy: "chris" });
  assert.equal((await attendees.ticketFor(next.id)).number, 2, "a claimed number was handed out again");
});

test("the database refuses to release a claimed number, whatever the code does", opts, async () => {
  // Straight SQL. Two people carrying VIP 1 is the one failure that cannot be
  // sorted out at the door, so the rule is stated in the table as well.
  await reset();
  const who = await guest("belt@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris" });
  const badge = await attendees.ticketFor(who.id);
  await attendees.claimTicket(badge.id);

  await assert.rejects(
    () => db.query("update tickets set revoked_at = now(), released_at = now() where id = $1", [badge.id]),
    /tickets_claimed_numbers_are_kept/
  );
  // And on an unclaimed badge, where the claim rule is not in play, a number
  // still cannot be freed while the badge is valid.
  const live = await guest("live@example.com");
  await attendees.issueTicket({ attendeeId: live.id, category: "vip", issuedBy: "chris" });
  const valid = await attendees.ticketFor(live.id);
  await assert.rejects(
    () => db.query("update tickets set released_at = now() where id = $1", [valid.id]),
    /tickets_release_needs_withdrawal/
  );
});

test("claiming twice is not an error, and does not move the date", opts, async () => {
  await reset();
  const who = await guest("twice@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris" });
  const badge = await attendees.ticketFor(who.id);

  const first = await attendees.claimTicket(badge.id);
  const again = await attendees.claimTicket(badge.id);
  assert.deepEqual(again.claimed_at, first.claimed_at);
});

test("a withdrawn badge cannot be claimed", opts, async () => {
  await reset();
  const who = await guest("gone@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris" });
  const badge = await attendees.ticketFor(who.id);
  await attendees.revokeTicket(badge.id, { release: true });

  await assert.rejects(() => attendees.claimTicket(badge.id), /no longer valid/);
});

test("a freed number can be handed to a chosen person, not just the next one", opts, async () => {
  // Freeing 7 is only half of "give 7 to somebody else": the allocator takes
  // the lowest free number, which may not be the one just released.
  await reset();
  const held = [];
  for (let i = 0; i < 3; i++) {
    const g = await guest(`v${i}@example.com`);
    await attendees.issueTicket({ attendeeId: g.id, category: "vip", issuedBy: "chris" });
    held.push(await attendees.ticketFor(g.id));
  }
  assert.deepEqual(held.map((t) => t.number), [1, 2, 3]);

  // Free the middle one and the last one.
  await attendees.revokeTicket(held[1].id, { release: true });
  await attendees.revokeTicket(held[2].id, { release: true });

  const chosen = await guest("chosen@example.com");
  await attendees.issueTicket({ attendeeId: chosen.id, category: "vip", issuedBy: "chris", number: 3 });
  assert.equal((await attendees.ticketFor(chosen.id)).number, 3, "the asked-for number was not honoured");

  // And the pool still holds 2, which the next automatic issue takes.
  const auto = await guest("auto@example.com");
  await attendees.issueTicket({ attendeeId: auto.id, category: "vip", issuedBy: "chris" });
  assert.equal((await attendees.ticketFor(auto.id)).number, 2);
});

test("an asked-for number that is taken is refused, not quietly swapped", opts, async () => {
  await reset();
  const first = await guest("one@example.com");
  await attendees.issueTicket({ attendeeId: first.id, category: "vip", issuedBy: "chris" });

  const second = await guest("two@example.com");
  await assert.rejects(
    () => attendees.issueTicket({ attendeeId: second.id, category: "vip", issuedBy: "chris", number: 1 }),
    /already held/
  );
  assert.equal(await attendees.ticketFor(second.id), null, "a different badge was issued instead");
});

test("an asked-for number still has to belong to its category", opts, async () => {
  await reset();
  const who = await guest("range@example.com");
  await assert.rejects(
    () => attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris", number: 40 }),
    /outside the vip range/
  );
  await assert.rejects(
    () => attendees.issueTicket({ attendeeId: who.id, category: "speaker", issuedBy: "chris", number: 5 }),
    /do not carry numbers/
  );
  await assert.rejects(
    () => attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris", number: "seven" }),
    /whole number/
  );
});

test("capacity counts a freed number as available again", opts, async () => {
  await reset();
  const who = await guest("cap@example.com");
  await attendees.issueTicket({ attendeeId: who.id, category: "vip", issuedBy: "chris" });
  const badge = await attendees.ticketFor(who.id);

  let vip = (await attendees.capacity()).find((c) => c.category === "vip");
  assert.equal(vip.issued, 1);

  await attendees.revokeTicket(badge.id, { release: true });
  vip = (await attendees.capacity()).find((c) => c.category === "vip");
  assert.equal(vip.issued, 0, "a freed place is still being counted as taken");
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
