import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Taking payment, through Stripe Checkout.
 *
 * Checkout rather than a form of our own: the card details are entered on
 * Stripe's page, never on this site and never in this process. That is the
 * whole reason for the redirect, and it is worth the redirect.
 *
 * Over the REST API rather than the SDK. Two calls are needed -- create a
 * session, and verify a webhook signature -- and both are a handful of lines,
 * against a dependency that would have to be kept current in a container that
 * also builds the site.
 *
 * Without a key none of this is reachable and nothing about the site changes.
 */

const API = "https://api.stripe.com/v1";

/** Stripe's default, and the one they say never to set to zero. */
const TOLERANCE_SECONDS = 300;

/** Form-encode the way Stripe's API expects nested parameters. */
export function encode(params, prefix = "") {
  const out = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") out.push(encode(value, name));
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return out.filter(Boolean).join("&");
}

/**
 * Is a webhook really from Stripe?
 *
 * The signed payload is the timestamp, a full stop, and the body exactly as it
 * arrived -- reparsed or reformatted JSON will not verify, which is why the
 * caller has to hand over the raw bytes.
 *
 * Only v1 signatures count. Stripe sends a v0 alongside them for test events
 * and says to ignore every scheme that is not v1, or a downgrade is on offer.
 */
export function verifySignature({ payload, header, secret, now = Date.now, tolerance = TOLERANCE_SECONDS }) {
  if (!secret) return { ok: false, why: "no webhook secret is configured" };
  if (!header) return { ok: false, why: "no Stripe-Signature header" };

  const parts = String(header)
    .split(",")
    .map((p) => p.split("="))
    .filter((p) => p.length === 2);

  const timestamp = parts.find(([k]) => k.trim() === "t")?.[1]?.trim();
  const signatures = parts.filter(([k]) => k.trim() === "v1").map(([, v]) => v.trim());

  if (!timestamp || !signatures.length) return { ok: false, why: "the header is malformed" };

  const age = Math.abs(Math.floor(now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age)) return { ok: false, why: "the timestamp is not a number" };
  if (age > tolerance) return { ok: false, why: `the signature is ${age}s old` };

  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), body]))
    .digest("hex");

  // Constant time, and length-checked first because timingSafeEqual throws on
  // a length mismatch rather than returning false.
  const mine = Buffer.from(expected, "utf8");
  const matched = signatures.some((given) => {
    const theirs = Buffer.from(given, "utf8");
    return theirs.length === mine.length && timingSafeEqual(theirs, mine);
  });

  return matched ? { ok: true } : { ok: false, why: "no signature matched" };
}

export function createStripe({ env, fetchImpl = globalThis.fetch } = {}) {
  const key = () => env("STRIPE_SECRET_KEY");
  const webhookSecret = () => env("STRIPE_WEBHOOK_SECRET");

  const configured = () => Boolean(key());

  async function call(path, params) {
    if (!configured()) throw new Error("Payments are not configured: STRIPE_SECRET_KEY is missing.");

    const res = await fetchImpl(`${API}${path}`, {
      method: "POST",
      headers: {
        // Basic auth with the secret key as the username and no password,
        // which is what `-u "sk_...:"` means in Stripe's own examples.
        Authorization: `Basic ${Buffer.from(`${key()}:`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: encode(params)
    });

    const text = await res.text();
    if (!res.ok) {
      // Stripe names the offending parameter. Passing that on saves an
      // afternoon of guessing from a status code.
      let said = text.slice(0, 300);
      try {
        said = JSON.parse(text).error?.message ?? said;
      } catch {
        /* the raw text will do */
      }
      throw new Error(`Stripe refused this (${res.status}): ${said}`);
    }
    return JSON.parse(text);
  }

  return {
    configured,
    webhookConfigured: () => Boolean(webhookSecret()),

    /**
     * A page to send somebody to in order to pay.
     *
     * The price is built here rather than looked up at Stripe: the amount
     * lives in this database, beside the event and the badge category it is
     * for, and keeping a mirror of it in a second system is a way of ending up
     * with two different answers.
     */
    async checkout({ event, category, label, amount, currency, email, successUrl, cancelUrl, reference }) {
      const session = await call("/checkout/sessions", {
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: reference,
        ...(email ? { customer_email: email } : {}),
        // Read back on the way in, so a tampered-with return cannot claim a
        // seat that was not paid for.
        metadata: { event, category },
        line_items: {
          0: {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amount,
              product_data: { name: label }
            }
          }
        }
      });

      return { id: session.id, url: session.url };
    },

    /** The event, if the signature holds. */
    readWebhook({ payload, header, now }) {
      const check = verifySignature({ payload, header, secret: webhookSecret(), now });
      if (!check.ok) return check;
      try {
        return { ok: true, event: JSON.parse(payload.toString("utf8")) };
      } catch {
        return { ok: false, why: "the body is not JSON" };
      }
    }
  };
}
