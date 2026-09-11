import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createAttendees } from "../admin/attendees.js";
import { createPgUserStore } from "../admin/users-store-pg.js";

/**
 * One address is one person.
 *
 * Administrators and attendees live in separate tables, and for a while that
 * meant two passwords for anybody who was both -- a speaker who also runs the
 * site signed in with the password he knew and was told, in effect, that he
 * was somebody else. So promotion takes the credential that already exists
 * rather than inventing a second one, and a password set on either side is
 * written to both.
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
let attendees;
let users;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  attendees = createAttendees({ db });
  users = createPgUserStore({ db });
});

after(async () => {
  if (db) await db.end();
});

async function reset() {
  await db.query("truncate attendees cascade");
  await db.query("delete from admin_users where not is_owner");
  await db.query("delete from admin_users where email like '%@example.com'");
}

const speaker = async (email, password = null) => {
  const guest = await attendees.create({ email, category: "speaker" }, "chris@onchainlabs.ch");
  if (password) await attendees.setPassword(guest.id, password);
  return guest;
};

// --------------------------------------------------------------- promoting

test("promoting keeps the password they already use", opts, async () => {
  await reset();
  await speaker("florian@example.com", "the-password-he-knows");

  const promoted = await users.promote("florian@example.com", "chris@onchainlabs.ch");
  assert.equal(promoted.email, "florian@example.com");
  assert.equal(promoted.needsPassword, false);

  assert.ok(
    await users.verify("florian@example.com", "the-password-he-knows"),
    "he cannot administer the site with the only password he has"
  );
  assert.ok(await attendees.verify("florian@example.com", "the-password-he-knows"));
});

test("somebody with no password yet can still be promoted, but cannot sign in", opts, async () => {
  // Invited, on the guest list, never clicked the link. The role is recorded;
  // it grants nothing until there is a password to check.
  await reset();
  await speaker("invited@example.com");

  const promoted = await users.promote("invited@example.com", "chris@onchainlabs.ch");
  assert.equal(promoted.needsPassword, true);
  assert.ok(await users.exists("invited@example.com"));
  assert.equal(await users.verify("invited@example.com", ""), false);
  assert.equal(await users.verify("invited@example.com", "anything-at-all"), false);
});

test("the link they are sent sets one password, not two", opts, async () => {
  await reset();
  const guest = await speaker("later@example.com");
  await users.promote("later@example.com", "chris@onchainlabs.ch");

  // What the set-password link does when they follow it.
  await attendees.setPassword(guest.id, "the-one-they-choose");

  assert.ok(await attendees.verify("later@example.com", "the-one-they-choose"));
  assert.ok(
    await users.verify("later@example.com", "the-one-they-choose"),
    "the password they set did not reach the admin side"
  );
});

test("promoting somebody twice says so rather than making a second account", opts, async () => {
  await reset();
  await speaker("twice@example.com", "a-long-enough-password");
  await users.promote("twice@example.com", "chris@onchainlabs.ch");
  await assert.rejects(
    () => users.promote("twice@example.com", "chris@onchainlabs.ch"),
    /already administers/
  );
});

// --------------------------------------------- people without an address

test("somebody can be added before anybody has their email", opts, async () => {
  // Twenty-six speakers were published on the site long before their
  // addresses turned up. They still need a badge and a number.
  await reset();
  const who = await attendees.create(
    { firstName: "Lia", lastName: "Müller Peña", category: "speaker", company: "OnChain Labs" },
    "chris@onchainlabs.ch"
  );

  assert.equal(who.email, null);
  assert.equal(who.name, "Lia Müller Peña");

  // And they can hold a badge, which is the point of being on the list.
  await attendees.issueTicket({ attendeeId: who.id, category: "speaker", issuedBy: "chris" });
  assert.ok(await attendees.ticketFor(who.id));
});

test("a row with neither a name nor an address is refused", opts, async () => {
  await reset();
  await assert.rejects(
    () => attendees.create({ category: "visitor" }, "chris@onchainlabs.ch"),
    /email address or a name/
  );
});

test("people with no address do not collide, and cannot be signed into", opts, async () => {
  // They all have the same null. An empty lookup must not match any of them,
  // or one would be handed another's profile.
  await reset();
  await attendees.create({ firstName: "One", category: "speaker" }, "chris");
  await attendees.create({ firstName: "Two", category: "speaker" }, "chris");

  assert.equal(await attendees.byEmail(""), null);
  assert.equal(await attendees.byEmail(null), null);
  assert.equal(await attendees.byEmail(undefined), null);
  assert.equal(await attendees.verify("", ""), false);
  assert.equal(await attendees.verify(null, "anything"), false);
});

test("an address can be filled in later, once", opts, async () => {
  await reset();
  const who = await attendees.create({ firstName: "Later", category: "speaker" }, "chris");

  const filled = await attendees.setEmail(who.id, "  Later@Example.com ");
  assert.equal(filled.email, "later@example.com", "the address should be normalised");

  // Not a way to move an address from one person to another.
  await assert.rejects(() => attendees.setEmail(who.id, "other@example.com"), /already has an email/);
});

test("filling in an address somebody else already has is refused", opts, async () => {
  await reset();
  await attendees.create({ email: "taken@example.com", category: "visitor" }, "chris");
  const who = await attendees.create({ firstName: "Nameless", category: "speaker" }, "chris");

  await assert.rejects(() => attendees.setEmail(who.id, "taken@example.com"), /already registered/);
  assert.equal((await attendees.byId(who.id)).email, null, "the address was taken anyway");
});

test("a guest still cannot change their own address", opts, async () => {
  // email is kept out of the writable fields for this reason; setEmail is the
  // admin's own path in and only fills a gap.
  await reset();
  const who = await attendees.create({ email: "mine@example.com", category: "visitor" }, "chris");
  await attendees.update(who.id, { email: "theirs@example.com", company: "Somewhere" });

  const after = await attendees.byId(who.id);
  assert.equal(after.email, "mine@example.com", "an address was changed through update()");
  assert.equal(after.company, "Somewhere", "the rest of the update was dropped");
});

// -------------------------------------------- an administrator is a person

test("a new admin account comes with a profile", opts, async () => {
  // The site had administrators with nowhere to go: no profile, no details,
  // nothing to edit, and no way back to themselves from the admin.
  await reset();
  await users.createUser("fresh@example.com", "a-long-enough-password", "a test");

  const profile = await attendees.byEmail("fresh@example.com");
  assert.ok(profile, "an administrator was created with no profile");
  assert.equal(profile.category, "visitor");
  assert.equal(profile.selfRegistered, false);

  // The same password opens both halves of them.
  assert.ok(await attendees.verify("fresh@example.com", "a-long-enough-password"));
  assert.ok(await users.verify("fresh@example.com", "a-long-enough-password"));

  // And no badge: being an administrator is not being a guest.
  assert.equal(await attendees.ticketFor(profile.id), null);
});

test("giving an admin a profile does not disturb one they already have", opts, async () => {
  await reset();
  const guest = await speaker("keeps@example.com", "the-password-he-knows");
  await users.promote("keeps@example.com", "chris@onchainlabs.ch");

  const after = await attendees.byEmail("keeps@example.com");
  assert.equal(after.id, guest.id, "a second profile was made for the same address");
  assert.equal(after.category, "speaker", "their category was overwritten");
});

// ------------------------------------------------------ one password, both

test("changing the password on the profile changes it for the admin", opts, async () => {
  await reset();
  const guest = await speaker("sync@example.com", "the-first-password");
  await users.promote("sync@example.com", "chris@onchainlabs.ch");

  await attendees.setPassword(guest.id, "the-second-password");

  assert.ok(await users.verify("sync@example.com", "the-second-password"));
  assert.equal(
    await users.verify("sync@example.com", "the-first-password"),
    false,
    "the old password still administers the site"
  );
});

test("changing it on the admin side changes it for the profile", opts, async () => {
  await reset();
  await speaker("other@example.com", "the-first-password");
  await users.promote("other@example.com", "chris@onchainlabs.ch");

  await users.changePassword("other@example.com", "the-first-password", "changed-from-the-admin");

  assert.ok(await attendees.verify("other@example.com", "changed-from-the-admin"));
  assert.equal(
    await attendees.verify("other@example.com", "the-first-password"),
    false,
    "the old password still opens their profile"
  );
});

test("a password change reaches nobody else", opts, async () => {
  // The mirror is keyed on the address, and has to stay that way.
  await reset();
  const mine = await speaker("mine@example.com", "my-own-password");
  await speaker("theirs@example.com", "their-own-password");
  await users.promote("theirs@example.com", "chris@onchainlabs.ch");

  await attendees.setPassword(mine.id, "a-replacement-password");

  assert.ok(
    await attendees.verify("theirs@example.com", "their-own-password"),
    "somebody else's password was overwritten"
  );
  assert.ok(await users.verify("theirs@example.com", "their-own-password"));
});

test("an attendee who administers nothing gains nothing from the mirror", opts, async () => {
  await reset();
  const guest = await speaker("plain@example.com", "a-long-enough-password");
  await attendees.setPassword(guest.id, "another-long-password");
  assert.equal(await users.exists("plain@example.com"), false);
  assert.equal(await users.verify("plain@example.com", "another-long-password"), false);
});
