import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createSettings } from "../admin/site-settings.js";
import { sleepBanner, sleepPage } from "../admin/sleep-page.js";

/**
 * Closed for a while.
 *
 * Between events the site says so rather than showing the last one as though
 * it were still coming. What has to keep working while it does: the admin,
 * because somebody has to be able to wake it up; everybody's profile and
 * badge, because those are theirs either way; and the stylesheet, because the
 * notice is not meant to look like a broken page.
 */
const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run these" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests write to it." }
    : {};

let db;
let settings;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  settings = createSettings({ db, ttlMs: 0 });
});

after(async () => {
  if (db) await db.end();
});

// ------------------------------------------------------------------ the page

test("the notice says what it was given, and escapes it", () => {
  const html = sleepPage({
    heading: "Thank you.",
    message: 'Back for the next one <script>alert("x")</script>'
  });
  assert.match(html, /Thank you\./);
  assert.doesNotMatch(html, /<script>alert/, "the message was not escaped");
  assert.match(html, /&lt;script&gt;/);
  // Styled by the site's own stylesheet, so being closed still looks like the
  // same organisation rather than like something broken.
  assert.match(html, /assets\/css\/styles\.css/);
  // And a way in for somebody who already has a badge.
  assert.match(html, /href="\/portal"/);
});

test("an administrator is told why they are seeing the real site", () => {
  // They bypass the notice so that checking what is about to be published
  // does not require publishing it. Silently, that is indistinguishable from
  // the switch not working -- and the person who just turned it on is the one
  // person guaranteed to look.
  const banner = sleepBanner();
  assert.match(banner, /asleep/);
  assert.match(banner, /signed in as an administrator/);
  assert.match(banner, /href="\/admin\/sleep"/, "no way back to the switch");
  // It has to survive whatever page it lands on, so it carries its own styles.
  assert.match(banner, /position:fixed/);
  assert.match(banner, /z-index:2147483647/);
});

// -------------------------------------------------------------- the setting

test("a site with no setting stored is awake", opts, async () => {
  // The failure this avoids is a site that puts itself to sleep because a
  // query came back empty.
  await db.query("delete from site_settings where key = 'sleep'");
  settings.forget();
  const sleep = await settings.sleep();
  assert.equal(sleep.on, false);
  assert.equal(sleep.heading, "Thank you.");
  assert.ok(sleep.message.length > 10, "there should still be something to say");
});

test("the switch is remembered, and so are the words", opts, async () => {
  await settings.set("sleep", { on: true, heading: "Back soon.", message: "Working on it." }, "chris");
  settings.forget();

  const sleep = await settings.sleep();
  assert.equal(sleep.on, true);
  assert.equal(sleep.heading, "Back soon.");
  assert.equal(sleep.message, "Working on it.");
});

test("empty words fall back rather than showing an empty page", opts, async () => {
  await settings.set("sleep", { on: true, heading: "   ", message: "" }, "chris");
  settings.forget();

  const sleep = await settings.sleep();
  assert.equal(sleep.on, true);
  assert.equal(sleep.heading, "Thank you.");
  assert.match(sleep.message, /next experience/);
});

test("anything but true is awake", opts, async () => {
  // Including the strings a form might send if the checkbox were read wrong.
  for (const value of ["yes", "true", 1, null, undefined, "on"]) {
    await settings.set("sleep", { on: value, heading: "h", message: "m" }, "chris");
    settings.forget();
    assert.equal((await settings.sleep()).on, false, `on: ${JSON.stringify(value)}`);
  }
  await settings.set("sleep", { on: true, heading: "h", message: "m" }, "chris");
  settings.forget();
  assert.equal((await settings.sleep()).on, true);
});

test("the answer is held briefly rather than read on every request", opts, async () => {
  // Every page view asks. One query per few seconds, not one per visitor.
  const held = createSettings({ db, ttlMs: 60000 });
  await held.set("sleep", { on: false, heading: "h", message: "m" }, "chris");

  let queries = 0;
  const counting = createSettings({
    db: { query: (...args) => (queries += 1, db.query(...args)) },
    ttlMs: 60000
  });

  await counting.sleep();
  await counting.sleep();
  await counting.sleep();
  assert.equal(queries, 1, "the setting was read more than once");
});

test("a change is not held for ever", opts, async () => {
  // Another instance may have served the write, so the cache expires rather
  // than waiting to be told.
  let clock = 0;
  const brief = createSettings({ db, ttlMs: 100, now: () => clock });

  await db.query("update site_settings set value = jsonb_set(value, '{on}', 'false') where key = 'sleep'");
  brief.forget();
  assert.equal((await brief.sleep()).on, false);

  await db.query("update site_settings set value = jsonb_set(value, '{on}', 'true') where key = 'sleep'");
  assert.equal((await brief.sleep()).on, false, "it should still be holding the old answer");

  clock += 200;
  assert.equal((await brief.sleep()).on, true, "the change never arrived");
});
