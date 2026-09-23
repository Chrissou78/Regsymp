import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createEvents } from "../admin/events.js";
import { createPrices, formatAmount, parseAmount, plainAmount } from "../admin/prices.js";

/**
 * What a seat costs, and who has paid for one.
 *
 * The arithmetic is tested without a database because it is where the money
 * gets lost: a price typed as "500" that becomes five euro, or fifty thousand.
 * The store is tested with one because the rules that matter -- one price per
 * event and category, no price meaning not for sale, a webhook that cannot pay
 * twice -- are all enforced by the schema.
 */

// ------------------------------------------------------------------ the money

test("a price is read the way a person types it", () => {
  assert.equal(parseAmount("500"), 50000);
  assert.equal(parseAmount("500.00"), 50000);
  assert.equal(parseAmount("€500"), 50000);
  assert.equal(parseAmount("1,250.50"), 125050);
  assert.equal(parseAmount("499,50"), 49950, "a comma is a decimal point in half of Europe");
});

test("zero-decimal currencies are not multiplied by a hundred", () => {
  assert.equal(parseAmount("50000", "jpy"), 50000);
  assert.equal(formatAmount(50000, "jpy"), "JPY 50000");
});

test("a price that is not one is refused rather than rounded", () => {
  for (const bad of ["", "   ", "0", "-100", "abc", "1.005"]) {
    assert.throws(() => parseAmount(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseAmount("2000000"), /mistake/);
});

test("what comes out is what went in", () => {
  // The number in the form has to be the number that was saved, or an edit
  // that changes nothing still changes the price.
  for (const typed of ["500", "499.50", "1250"]) {
    assert.equal(plainAmount(parseAmount(typed)), typed.replace(/\.00$/, ""));
  }
});

test("a round price does not show its zeroes", () => {
  assert.equal(formatAmount(50000, "eur"), "€500");
  assert.equal(formatAmount(49950, "eur"), "€499.50");
  assert.equal(formatAmount(50000, "gbp"), "£500");
  assert.equal(formatAmount(50000, "chf"), "CHF 500");
});

// ------------------------------------------------------------------- the store

const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run these" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests truncate tables." }
    : {};

let db;
let prices;
let events;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  prices = createPrices({ db });
  events = createEvents({ db });
});

after(async () => {
  if (db) await db.end();
});

async function reset() {
  await db.query("truncate payments, event_prices, events cascade");
  await events.create({ slug: "palma-2026", name: "RegSymp Palma", whenLabel: "September 2026" }, "a test");
}

test("every category is offered a price, including the ones without one", opts, async () => {
  await reset();
  const seats = await prices.forEvent("palma-2026");
  assert.ok(seats.length >= 3, "the three the event is built around should all be there");
  assert.ok(seats.every((s) => s.priced === false));
  assert.deepEqual(await prices.onSaleFor("palma-2026"), [], "nothing is for sale by default");
});

test("priced is not the same as on sale", opts, async () => {
  await reset();
  // The price is agreed weeks before the seats open. Those are two decisions
  // and conflating them means agreeing a number puts it on sale.
  await prices.set("palma-2026", "vip", { amount: "1500", onSale: false });
  assert.deepEqual(await prices.onSaleFor("palma-2026"), []);
  assert.equal(await prices.priceFor("palma-2026", "vip"), null);

  await prices.set("palma-2026", "vip", { amount: "1500", onSale: true });
  const open = await prices.onSaleFor("palma-2026");
  assert.equal(open.length, 1);
  assert.equal(open[0].display, "€1500");
});

test("a second price for the same seat replaces the first", opts, async () => {
  await reset();
  await prices.set("palma-2026", "visitor", { amount: "300", onSale: true });
  await prices.set("palma-2026", "visitor", { amount: "350", onSale: true });
  const seats = (await prices.forEvent("palma-2026")).filter((s) => s.priced);
  assert.equal(seats.length, 1, "two rows for one seat would be two prices");
  assert.equal(seats[0].amount, 35000);
});

test("clearing the price takes the seats off sale entirely", opts, async () => {
  await reset();
  await prices.set("palma-2026", "visitor", { amount: "300", onSale: true });
  await prices.clear("palma-2026", "visitor");
  assert.deepEqual(await prices.onSaleFor("palma-2026"), []);
  assert.equal((await prices.forEvent("palma-2026")).find((s) => s.category === "visitor").priced, false);
});

test("prices belong to an event, not to the site", opts, async () => {
  await reset();
  await events.create({ slug: "davos-2027", name: "The 33 · Davos", whenLabel: "January 2027" }, "a test");
  await prices.set("palma-2026", "vip", { amount: "1500", onSale: true });
  await prices.set("davos-2027", "vip", { amount: "3300", onSale: true });

  assert.equal((await prices.priceFor("palma-2026", "vip")).amount, 150000);
  assert.equal((await prices.priceFor("davos-2027", "vip")).amount, 330000);
});

test("a price for an event that does not exist is refused", opts, async () => {
  await reset();
  await assert.rejects(
    () => prices.set("never-happened", "vip", { amount: "100", onSale: true }),
    /no such event/
  );
});

test("removing an event takes its prices with it", opts, async () => {
  await reset();
  await events.create({ slug: "gone-2027", name: "Gone", whenLabel: "Never" }, "a test");
  await prices.set("gone-2027", "vip", { amount: "100", onSale: true });
  await events.remove("gone-2027");
  assert.deepEqual(await prices.onSaleFor("gone-2027"), []);
});

// ----------------------------------------------------------------- payments

const opening = (sessionId, over = {}) =>
  prices.open({
    sessionId,
    eventSlug: "palma-2026",
    category: "vip",
    email: "buyer@example.com",
    name: "A Buyer",
    amount: 150000,
    currency: "eur",
    ...over
  });

test("a payment is written before the buyer reaches Stripe", opts, async () => {
  await reset();
  const opened = await opening("cs_test_1");
  assert.equal(opened.status, "pending");
  assert.equal(opened.display, "€1500");
  assert.equal((await prices.bySession("cs_test_1")).email, "buyer@example.com");
});

test("the same session cannot be paid twice, however often the webhook arrives", opts, async () => {
  await reset();
  await opening("cs_test_2");

  const first = await prices.markPaid({ sessionId: "cs_test_2", stripeEvent: "evt_1" });
  assert.equal(first.status, "paid");

  // Stripe retries for three days and says an endpoint may see the same event
  // more than once. The second call has to come back empty, or the caller
  // issues a second badge.
  const second = await prices.markPaid({ sessionId: "cs_test_2", stripeEvent: "evt_1" });
  assert.equal(second, null);
});

test("opening the same session twice does not make two payments", opts, async () => {
  await reset();
  await opening("cs_test_3");
  const again = await opening("cs_test_3");
  assert.equal(again, null, "the second open should be a no-op, not a duplicate row");
  assert.equal((await prices.list({})).length, 1);
});

test("an address Stripe collected fills one the form did not", opts, async () => {
  await reset();
  await opening("cs_test_4", { email: null, name: null });
  const paid = await prices.markPaid({
    sessionId: "cs_test_4",
    stripeEvent: "evt_2",
    email: "Collected@Example.com",
    name: "Collected Name"
  });
  assert.equal(paid.email, "collected@example.com");
  assert.equal(paid.name, "Collected Name");
});

test("an abandoned payment expires rather than staying pending for ever", opts, async () => {
  await reset();
  await opening("cs_test_5");
  await prices.markFailed("cs_test_5", "expired");
  assert.equal((await prices.bySession("cs_test_5")).status, "expired");
  // And an expired one cannot then be marked paid by a late webhook.
  assert.equal(await prices.markPaid({ sessionId: "cs_test_5" }), null);
});

test("takings are counted only once the money is in", opts, async () => {
  await reset();
  await opening("cs_test_6");
  await opening("cs_test_7");
  assert.deepEqual(await prices.takings("palma-2026"), [], "pending is not taken");

  await prices.markPaid({ sessionId: "cs_test_6", stripeEvent: "evt_3" });
  const taken = await prices.takings("palma-2026");
  assert.equal(taken.length, 1);
  assert.equal(taken[0].sold, 1);
  assert.equal(taken[0].display, "€1500");
});

test("the list can be narrowed to what went wrong", opts, async () => {
  await reset();
  await opening("cs_test_8");
  await opening("cs_test_9");
  await prices.markPaid({ sessionId: "cs_test_8", stripeEvent: "evt_4" });

  assert.equal((await prices.list({ status: "paid" })).length, 1);
  assert.equal((await prices.list({ status: "pending" })).length, 1);
  assert.equal((await prices.list({ eventSlug: "somewhere-else" })).length, 0);
});
