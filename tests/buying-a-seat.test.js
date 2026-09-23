import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createDb, migrate } from "../admin/db.js";
import { createAttendees } from "../admin/attendees.js";
import { createEvents } from "../admin/events.js";
import { createPrices } from "../admin/prices.js";
import { createPaymentPages } from "../payments/routes.js";

/**
 * Buying a seat, end to end and over HTTP.
 *
 * Against a real database because every rule worth testing is the schema's:
 * one payment per session, one badge per person, a number taken from the
 * category's own range.
 *
 * No network. Stripe is a stub that records what it was asked for and hands
 * back a session id, and the webhook is signed here with the same secret the
 * routes are given -- which is the point: a webhook that is not signed must
 * not issue a badge, because the badge is the thing of value.
 */

const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run these" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests truncate tables." }
    : {};

const SECRET = "whsec_a_test_secret";

let db;
let attendees;
let events;
let prices;
let server;
let base;

/** What Stripe was asked to charge, and what it was told to say back. */
const asked = [];
let stripeOn = true;
let stripeFails = false;
let awake = true;
const announced = [];

const stripe = {
  configured: () => stripeOn,
  webhookConfigured: () => true,
  checkout: async (args) => {
    if (stripeFails) throw new Error("Stripe is having a moment");
    asked.push(args);
    return { id: `cs_test_${asked.length}`, url: `https://checkout.stripe.test/${asked.length}` };
  },
  readWebhook: ({ payload, header }) => {
    const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.split("=")));
    const expected = createHmac("sha256", SECRET).update(`${parts.t}.${payload}`).digest("hex");
    if (parts.v1 !== expected) return { ok: false, why: "no signature matched" };
    return { ok: true, event: JSON.parse(payload.toString("utf8")) };
  }
};

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  attendees = createAttendees({ db });
  events = createEvents({ db });
  prices = createPrices({ db });

  const tickets = createPaymentPages({
    stripe,
    prices,
    events,
    attendees,
    open: async () => awake,
    onIssued: async (what) => announced.push(what),
    // Quiet: the routes log refusals on purpose, and a passing test run
    // should not look like a failing one.
    log: { log() {}, error() {} }
  });

  const { createServer } = await import("node:http");
  server = createServer(async (req, res) => {
    const url = new globalThis.URL(req.url, "http://localhost");
    if (await tickets.handle(req, res, url)) return;
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (db) await db.end();
});

async function reset({ onSale = true } = {}) {
  await db.query("truncate payments, event_prices, events, attendees cascade");
  asked.length = 0;
  announced.length = 0;
  stripeOn = true;
  stripeFails = false;
  awake = true;

  await events.create(
    { slug: "palma-2026", name: "RegSymp Palma", city: "Palma", whenLabel: "September 2026" },
    "a test"
  );
  await events.activate("palma-2026");
  await prices.set("palma-2026", "vip", { amount: "1500", onSale });
  await prices.set("palma-2026", "visitor", { amount: "300", onSale });
  // Priced but never opened, whatever the others are doing.
  await prices.set("palma-2026", "speaker", { amount: "100", onSale: false });
}

const get = (p) => fetch(base + p, { redirect: "manual" });

const buy = (fields) =>
  fetch(`${base}/tickets/buy`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });

/** A webhook signed the way Stripe signs one. */
function webhook(event, { secret = SECRET } = {}) {
  const body = JSON.stringify(event);
  const at = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return fetch(`${base}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${at},v1=${mac}` },
    body
  });
}

const completed = (sessionId, over = {}) => ({
  id: `evt_${sessionId}`,
  type: "checkout.session.completed",
  data: {
    object: {
      id: sessionId,
      payment_status: "paid",
      customer_details: { email: "buyer@example.com", name: "A Buyer" },
      ...over
    }
  }
});

// ------------------------------------------------------------------ the offer

test("the seats on sale are the ones with a price and the box ticked", opts, async () => {
  await reset();
  const body = await (await get("/tickets")).text();
  assert.match(body, /VIP/);
  assert.match(body, /€1500/);
  assert.match(body, /€300/);
  assert.doesNotMatch(body, /€100/, "a priced seat that is not on sale must not be buyable");
});

test("without a Stripe key nothing is on sale, and the page says so", opts, async () => {
  await reset();
  stripeOn = false;
  const body = await (await get("/tickets")).text();
  assert.doesNotMatch(body, /€1500/);
  assert.match(body, /not on sale|invitation/i);
});

test("a sleeping site sells nothing", opts, async () => {
  await reset();
  awake = false;
  assert.doesNotMatch(await (await get("/tickets")).text(), /€1500/);
  const res = await buy({ category: "vip", email: "a@example.com", name: "A" });
  assert.equal(res.status, 302);
  assert.equal(asked.length, 0, "a payment was opened while the site was asleep");
});

test("nothing is on sale when no event is live", opts, async () => {
  await reset();
  await events.standDown("palma-2026");
  assert.match(await (await get("/tickets")).text(), /no event open/i);
});

// ----------------------------------------------------------------- the buying

test("buying sends you to Stripe with the price this site holds", opts, async () => {
  await reset();
  const res = await buy({ category: "vip", email: "Buyer@Example.com", name: "A Buyer" });

  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(asked[0].amount, 150000);
  assert.equal(asked[0].currency, "eur");
  assert.equal(asked[0].category, "vip");
  assert.equal(asked[0].email, "buyer@example.com");

  // Written before the redirect, so the payment has somewhere to land.
  const opened = await prices.bySession("cs_test_1");
  assert.equal(opened.status, "pending");
  assert.equal(opened.amount, 150000);
});

test("the price comes from the database, never from the form", opts, async () => {
  await reset();
  // The obvious attack: post a cheaper amount and see whether it is believed.
  await buy({ category: "vip", email: "b@example.com", name: "B", amount: "1", price: "1" });
  assert.equal(asked[0].amount, 150000);
});

test("a category that is not on sale cannot be bought by posting its name", opts, async () => {
  await reset();
  const res = await buy({ category: "speaker", email: "b@example.com", name: "B" });
  assert.equal(res.status, 400);
  assert.equal(asked.length, 0);
  assert.match(await res.text(), /not on sale/);
});

test("a nonsense category is refused rather than charged for", opts, async () => {
  await reset();
  const res = await buy({ category: "emperor", email: "b@example.com", name: "B" });
  assert.equal(res.status, 400);
  assert.equal(asked.length, 0);
});

test("an address and a name are required, because the badge carries both", opts, async () => {
  await reset();
  for (const fields of [
    { category: "vip", email: "not-an-address", name: "B" },
    { category: "vip", email: "b@example.com", name: "" }
  ]) {
    const res = await buy(fields);
    assert.equal(res.status, 400);
  }
  assert.equal(asked.length, 0);
});

test("somebody who already holds a badge is not sold a second", opts, async () => {
  await reset();
  const guest = await attendees.create({ email: "held@example.com" }, "a test");
  await attendees.issueTicket({ attendeeId: guest.id, category: "vip", issuedBy: "a test" });

  const res = await buy({ category: "vip", email: "held@example.com", name: "Held" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /already have a badge/);
  assert.equal(asked.length, 0);
});

test("a checkout Stripe refuses does not leave a pending payment behind", opts, async () => {
  await reset();
  stripeFails = true;
  const res = await buy({ category: "vip", email: "b@example.com", name: "B" });
  assert.equal(res.status, 400);
  assert.equal((await prices.list({})).length, 0);
});

// ---------------------------------------------------------------- the webhook

test("a paid session issues the badge that was paid for", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  const res = await webhook(completed("cs_test_1"));
  assert.equal(res.status, 200);

  const guest = await attendees.byEmail("buyer@example.com");
  assert.ok(guest, "no account was made for the buyer");
  assert.equal(guest.firstName, "A");
  assert.equal(guest.lastName, "Buyer");

  const ticket = await attendees.ticketFor(guest.id);
  assert.ok(ticket, "paid and got nothing");
  assert.equal(ticket.category, "vip");

  const payment = await prices.bySession("cs_test_1");
  assert.equal(payment.status, "paid");
  assert.equal(payment.attendeeId, guest.id);
  assert.equal(payment.ticketId, ticket.id);
});

test("an unsigned webhook issues nothing", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  const res = await fetch(`${base}/api/stripe/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(completed("cs_test_1"))
  });
  assert.equal(res.status, 400);
  assert.equal(await attendees.byEmail("buyer@example.com"), null);
  assert.equal((await prices.bySession("cs_test_1")).status, "pending");
});

test("a webhook signed with the wrong secret issues nothing", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  const res = await webhook(completed("cs_test_1"), { secret: "whsec_someone_elses" });
  assert.equal(res.status, 400);
  assert.equal((await prices.bySession("cs_test_1")).status, "pending");
});

test("the same webhook twice is one badge, because Stripe redelivers", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  assert.equal((await webhook(completed("cs_test_1"))).status, 200);
  assert.equal((await webhook(completed("cs_test_1"))).status, 200);

  const guest = await attendees.byEmail("buyer@example.com");
  const { rows } = await db.query("select count(*)::int as n from tickets where attendee_id = $1", [
    guest.id
  ]);
  assert.equal(rows[0].n, 1, "a redelivered webhook issued a second badge");
  assert.equal(announced.length, 1, "and told them about it twice");
});

test("a completed session that is not paid issues nothing", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  // Some payment methods settle later. Completed is not the same as paid.
  const res = await webhook(completed("cs_test_1", { payment_status: "unpaid" }));
  assert.equal(res.status, 200);
  assert.equal(await attendees.byEmail("buyer@example.com"), null);
  assert.equal((await prices.bySession("cs_test_1")).status, "pending");
});

test("an expired session stops being pending", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  await webhook({
    id: "evt_gone",
    type: "checkout.session.expired",
    data: { object: { id: "cs_test_1" } }
  });
  assert.equal((await prices.bySession("cs_test_1")).status, "expired");
});

test("an existing account is used rather than duplicated", opts, async () => {
  await reset();
  // Somebody the organisers already added, who then paid for a seat. One
  // address is one person: a second account would split them in two.
  const known = await attendees.create(
    { email: "buyer@example.com", firstName: "Known", company: "Somewhere" },
    "a test"
  );
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });
  await webhook(completed("cs_test_1"));

  const { rows } = await db.query("select count(*)::int as n from attendees where email = $1", [
    "buyer@example.com"
  ]);
  assert.equal(rows[0].n, 1);
  assert.equal((await prices.bySession("cs_test_1")).attendeeId, known.id);
  assert.equal((await attendees.byId(known.id)).company, "Somewhere", "their details were overwritten");
});

test("a badge they already hold is recorded, not issued twice", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  // Issued by hand between the payment and the webhook.
  const guest = await attendees.create({ email: "buyer@example.com" }, "a test");
  const held = await attendees.issueTicket({
    attendeeId: guest.id,
    category: "visitor",
    issuedBy: "a test"
  });

  assert.equal((await webhook(completed("cs_test_1"))).status, 200);
  const payment = await prices.bySession("cs_test_1");
  assert.equal(payment.status, "paid");
  assert.equal(payment.ticketId, Number(held.id), "the payment should point at the badge they have");

  const { rows } = await db.query("select count(*)::int as n from tickets where attendee_id = $1", [
    guest.id
  ]);
  assert.equal(rows[0].n, 1);
});

test("the buyer is told, once the badge exists", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });
  await webhook(completed("cs_test_1"));

  assert.equal(announced.length, 1);
  assert.equal(announced[0].payment.display, "€1500");
  assert.equal(announced[0].guest.email, "buyer@example.com");
  assert.ok(announced[0].ticket.id);
  assert.match(announced[0].origin, /^http:\/\/127\.0\.0\.1:/);
});

test("an unsendable confirmation does not undo the badge", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  const boom = new Error("Resend is down");
  announced.push = () => {
    throw boom;
  };
  const res = await webhook(completed("cs_test_1"));
  delete announced.push;

  assert.equal(res.status, 200);
  const guest = await attendees.byEmail("buyer@example.com");
  assert.ok(await attendees.ticketFor(guest.id), "the badge was rolled back over an email");
});

// ---------------------------------------------------------------- coming back

test("the page after paying says what is true at the time", opts, async () => {
  await reset();
  await buy({ category: "vip", email: "buyer@example.com", name: "A Buyer" });

  // Before the webhook lands: honest rather than reassuring.
  assert.match(await (await get("/tickets/thanks?session=cs_test_1")).text(), /Nearly there/);

  await webhook(completed("cs_test_1"));
  assert.match(await (await get("/tickets/thanks?session=cs_test_1")).text(), /Thank you/);
});

test("a made-up session id shows nothing about anybody", opts, async () => {
  await reset();
  const body = await (await get("/tickets/thanks?session=cs_invented")).text();
  assert.doesNotMatch(body, /buyer@example\.com/);
  assert.match(body, /Nearly there/);
});
