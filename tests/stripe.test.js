import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createStripe, encode, verifySignature } from "../admin/stripe.js";

/**
 * Taking payment.
 *
 * No network. Two things matter here and neither needs one: that a request to
 * Stripe is shaped the way Stripe's API expects, and that a webhook nobody
 * signed is refused — the webhook is what issues a badge, so anyone who can
 * forge one can award themselves a seat.
 */

const SECRET = "whsec_test_0123456789abcdef";
const KEY = "sk_test_notreal";

const signed = (body, secret = SECRET, at = Math.floor(Date.now() / 1000)) => {
  const mac = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return `t=${at},v1=${mac}`;
};

// ------------------------------------------------------------------ encoding

test("nested parameters are flattened the way Stripe reads them", () => {
  const body = encode({
    mode: "payment",
    line_items: { 0: { quantity: 1, price_data: { currency: "eur", unit_amount: 50000 } } }
  });
  const fields = new URLSearchParams(body);
  assert.equal(fields.get("mode"), "payment");
  assert.equal(fields.get("line_items[0][quantity]"), "1");
  assert.equal(fields.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(fields.get("line_items[0][price_data][unit_amount]"), "50000");
});

test("nothing is not sent as the string 'null'", () => {
  const body = encode({ a: "yes", b: null, c: undefined });
  assert.equal(body, "a=yes");
});

test("a name with a space in it survives the round trip", () => {
  const fields = new URLSearchParams(encode({ product_data: { name: "VIP · The 33 · Palma" } }));
  assert.equal(fields.get("product_data[name]"), "VIP · The 33 · Palma");
});

// ----------------------------------------------------------------- signatures

test("a signature Stripe made verifies", () => {
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  assert.deepEqual(verifySignature({ payload: body, header: signed(body), secret: SECRET }), {
    ok: true
  });
});

test("a body changed by one character does not", () => {
  const body = '{"amount":50000}';
  const header = signed(body);
  const tampered = '{"amount":50001}';
  assert.equal(verifySignature({ payload: tampered, header, secret: SECRET }).ok, false);
});

test("somebody else's secret does not", () => {
  const body = '{"id":"evt_1"}';
  const header = signed(body, "whsec_a_different_one");
  assert.equal(verifySignature({ payload: body, header, secret: SECRET }).ok, false);
});

test("a signature from an hour ago is refused, so one cannot be replayed", () => {
  const body = '{"id":"evt_1"}';
  const old = Math.floor(Date.now() / 1000) - 3600;
  const check = verifySignature({ payload: body, header: signed(body, SECRET, old), secret: SECRET });
  assert.equal(check.ok, false);
  assert.match(check.why, /old/);
});

test("a v0 scheme is not accepted in place of v1", () => {
  // Stripe sends v0 alongside v1 for test events and says to ignore every
  // scheme that is not v1. Taking v0 would be a downgrade anyone could ask for.
  const body = '{"id":"evt_1"}';
  const at = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex");
  const check = verifySignature({ payload: body, header: `t=${at},v0=${mac}`, secret: SECRET });
  assert.equal(check.ok, false);
});

test("no header, no secret and nonsense are all refused rather than thrown", () => {
  const body = "{}";
  for (const header of [undefined, "", "garbage", "t=,v1=", "v1=abc"]) {
    assert.equal(verifySignature({ payload: body, header, secret: SECRET }).ok, false, String(header));
  }
  assert.equal(verifySignature({ payload: body, header: signed(body), secret: "" }).ok, false);
});

test("a signature of the wrong length is refused, not a crash", () => {
  // timingSafeEqual throws on a length mismatch rather than returning false,
  // which would turn a bad signature into a 500 and a retry storm.
  const body = "{}";
  const at = Math.floor(Date.now() / 1000);
  assert.doesNotThrow(() =>
    verifySignature({ payload: body, header: `t=${at},v1=deadbeef`, secret: SECRET })
  );
  assert.equal(verifySignature({ payload: body, header: `t=${at},v1=deadbeef`, secret: SECRET }).ok, false);
});

test("the signature is over the exact bytes, not over reparsed JSON", () => {
  // The same object, written differently. If the caller ever hands over a
  // re-serialised body instead of the raw one, this is what breaks.
  const raw = '{"id":"evt_1",  "amount":500}';
  const header = signed(raw);
  assert.equal(verifySignature({ payload: raw, header, secret: SECRET }).ok, true);
  assert.equal(
    verifySignature({ payload: JSON.stringify(JSON.parse(raw)), header, secret: SECRET }).ok,
    false
  );
});

// ------------------------------------------------------------------ checkout

test("without a key nothing can be sold, and saying so is the whole behaviour", async () => {
  const stripe = createStripe({ env: () => "", fetchImpl: () => assert.fail("called Stripe") });
  assert.equal(stripe.configured(), false);
  await assert.rejects(() => stripe.checkout({ amount: 1, currency: "eur" }), /not configured/);
});

test("a checkout session is created with the price this site holds", async () => {
  let sent;
  const stripe = createStripe({
    env: (name) => (name === "STRIPE_SECRET_KEY" ? KEY : ""),
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/1" })
      };
    }
  });

  const session = await stripe.checkout({
    event: "palma-2026",
    category: "vip",
    label: "VIP · RegSymp Palma",
    amount: 50000,
    currency: "eur",
    email: "buyer@example.com",
    reference: "palma-2026:vip",
    successUrl: "https://regsymp.com/tickets/thanks?session={CHECKOUT_SESSION_ID}",
    cancelUrl: "https://regsymp.com/tickets"
  });

  assert.deepEqual(session, { id: "cs_test_1", url: "https://checkout.stripe.com/c/1" });
  assert.equal(sent.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(sent.init.method, "POST");
  assert.equal(sent.init.headers["Content-Type"], "application/x-www-form-urlencoded");

  // Basic auth, the key as the username and no password: `-u "sk_...:"`.
  const [scheme, credential] = sent.init.headers.Authorization.split(" ");
  assert.equal(scheme, "Basic");
  assert.equal(Buffer.from(credential, "base64").toString(), `${KEY}:`);

  const fields = new URLSearchParams(sent.init.body);
  assert.equal(fields.get("mode"), "payment");
  assert.equal(fields.get("line_items[0][price_data][unit_amount]"), "50000");
  assert.equal(fields.get("line_items[0][price_data][currency]"), "eur");
  assert.equal(fields.get("line_items[0][price_data][product_data][name]"), "VIP · RegSymp Palma");
  assert.equal(fields.get("customer_email"), "buyer@example.com");

  // Read back when the webhook arrives, so a tampered-with return cannot
  // claim a seat in a category nobody paid for.
  assert.equal(fields.get("metadata[event]"), "palma-2026");
  assert.equal(fields.get("metadata[category]"), "vip");
});

test("no email means no customer_email, rather than an empty one", async () => {
  let body;
  const stripe = createStripe({
    env: () => KEY,
    fetchImpl: async (_url, init) => {
      body = init.body;
      return { ok: true, status: 200, text: async () => '{"id":"cs_1","url":"https://x"}' };
    }
  });
  await stripe.checkout({ label: "Seat", amount: 100, currency: "eur" });
  assert.equal(new URLSearchParams(body).has("customer_email"), false);
});

test("Stripe's own complaint is passed on, because it names the field", async () => {
  const stripe = createStripe({
    env: () => KEY,
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Invalid currency: xyz" } })
    })
  });
  await assert.rejects(
    () => stripe.checkout({ label: "Seat", amount: 100, currency: "xyz" }),
    /Invalid currency: xyz/
  );
});

test("a webhook is only read once its signature holds", () => {
  const stripe = createStripe({
    env: (name) => (name === "STRIPE_WEBHOOK_SECRET" ? SECRET : KEY)
  });

  const body = Buffer.from('{"id":"evt_9","type":"checkout.session.completed"}');
  const good = stripe.readWebhook({ payload: body, header: signed(body.toString()) });
  assert.equal(good.ok, true);
  assert.equal(good.event.id, "evt_9");

  assert.equal(stripe.readWebhook({ payload: body, header: "t=1,v1=00" }).ok, false);
});

test("without a webhook secret every webhook is refused", () => {
  // Better than accepting them: the webhook is what issues a badge, and an
  // unverified one is an open door.
  const stripe = createStripe({ env: (name) => (name === "STRIPE_SECRET_KEY" ? KEY : "") });
  assert.equal(stripe.webhookConfigured(), false);
  const body = Buffer.from("{}");
  assert.equal(stripe.readWebhook({ payload: body, header: signed("{}") }).ok, false);
});
