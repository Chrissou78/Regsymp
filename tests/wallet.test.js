import { test } from "node:test";
import assert from "node:assert/strict";
import { createWallet, passBodyFor } from "../admin/wallet.js";

/**
 * Wallet passes.
 *
 * No network and no key: what matters here is the content of the pass and the
 * refusal to act without a credential. The one field that has to be right is
 * barcodeValue -- if it does not carry the same /t/<code> URL as the printed
 * badge, a phone and a piece of card scan as two different things at the door.
 */

const guest = {
  name: "Thorsten Kanzler",
  email: "thorsten@example.com",
  company: "Independent"
};

const ticket = {
  id: 12,
  number: 1,
  category: "vip",
  categoryLabel: "VIP",
  colour: "#1C2B4A",
  label: "1/33",
  code: "abc123",
  areas: ["side:gala dinner", "side:harbour reception"]
};

const CHECKIN = "https://www.regsymp.com/t/abc123";

test("the pass carries the same code as the badge and the ticket page", () => {
  const body = passBodyFor({ guest, ticket, checkinUrl: CHECKIN });
  assert.equal(body.barcodeValue, CHECKIN);
  assert.equal(body.barcodeFormat, "QR");
});

test("the pass says who and what, and the number is on it", () => {
  const body = passBodyFor({ guest, ticket, checkinUrl: CHECKIN });
  assert.deepEqual(body.headerFields, [{ label: "Badge", value: "1/33" }]);
  assert.deepEqual(body.primaryFields, [{ label: "Name", value: "Thorsten Kanzler" }]);
  assert.equal(body.secondaryFields[0].value, "VIP");
  assert.equal(body.secondaryFields[1].value, "Independent");
  assert.equal(body.organizationName, "RegSymp");
});

test("side events reach the back of the pass, without the prefix", () => {
  const body = passBodyFor({ guest, ticket, checkinUrl: CHECKIN });
  const side = body.backFields.find((f) => f.label === "Side events");
  assert.equal(side.value, "gala dinner, harbour reception");
});

test("empty fields are left out rather than sent blank", () => {
  const body = passBodyFor({
    guest: { email: "nobody@example.com" },
    ticket: { ...ticket, areas: [], number: null, label: "Speaker" },
    checkinUrl: CHECKIN
  });
  assert.ok(!body.backFields.some((f) => f.label === "Side events"));
  assert.ok(!body.secondaryFields.some((f) => f.label === "Company"));
  // Falls back to the address, because a pass with no name on it is useless.
  assert.equal(body.primaryFields[0].value, "nobody@example.com");
});

test("an unnumbered badge names itself under the code", () => {
  const body = passBodyFor({
    guest,
    ticket: { ...ticket, number: null, categoryLabel: "Speaker", label: "Speaker" },
    checkinUrl: CHECKIN
  });
  assert.equal(body.barcodeAltText, "Speaker");
  assert.equal(body.headerFields[0].value, "Speaker");
});

test("each category gets its own colour, within the presets on offer", () => {
  const preset = (colour) => passBodyFor({ guest, ticket: { ...ticket, colour }, checkinUrl: CHECKIN }).colorPreset;
  assert.equal(preset("#B8963A"), "orange");
  assert.equal(preset("#1C2B4A"), "dark");
  assert.equal(preset("#6B7FA0"), "blue");
  // A category the organisers add in a colour of their own still gets a pass.
  assert.equal(preset("#123456"), "dark");
  assert.equal(preset(null), "dark");
});

test("a badge is personal, and the pass says so", () => {
  const body = passBodyFor({ guest, ticket, checkinUrl: CHECKIN });
  assert.equal(body.sharingProhibited, true);
});

// ------------------------------------------------------------- the credential

test("without a key, no pass is attempted", async () => {
  const wallet = createWallet({
    env: () => "",
    fetchImpl: () => assert.fail("the provider was called with no key")
  });
  assert.equal(wallet.configured(), false);
  await assert.rejects(
    () => wallet.createPass({ guest, ticket, checkinUrl: CHECKIN }),
    /WALLETWALLET_API_KEY is missing/
  );
});

test("with a key, the pass is created and its serial comes back", async () => {
  const seen = [];
  const wallet = createWallet({
    env: () => "ww_live_test",
    fetchImpl: async (url, options) => {
      seen.push({ url, ...options });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            serialNumber: "ser-1",
            shareUrl: "https://api.walletwallet.dev/p/ser-1",
            googleSaveUrl: "https://pay.google.com/gp/v/save/jwt",
            applePass: "base64"
          })
      };
    }
  });

  const pass = await wallet.createPass({ guest, ticket, checkinUrl: CHECKIN });
  assert.equal(pass.serial, "ser-1");
  assert.equal(pass.url, "https://api.walletwallet.dev/p/ser-1");

  assert.equal(seen[0].url, "https://api.walletwallet.dev/api/passes");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].headers.Authorization, "Bearer ww_live_test");
  assert.equal(JSON.parse(seen[0].body).barcodeValue, CHECKIN);
});

test("an update goes to the pass by its serial", async () => {
  let seen;
  const wallet = createWallet({
    env: () => "ww_live_test",
    fetchImpl: async (url, options) => {
      seen = { url, method: options.method };
      return { ok: true, status: 200, text: async () => JSON.stringify({ serialNumber: "ser-1" }) };
    }
  });

  await wallet.updatePass({ serial: "ser-1", guest, ticket, checkinUrl: CHECKIN });
  assert.equal(seen.url, "https://api.walletwallet.dev/api/passes/ser-1");
  assert.equal(seen.method, "PUT");
});

test("the provider's own complaint is passed on, not swallowed", async () => {
  // It names the offending field. A status code alone wastes an afternoon.
  const wallet = createWallet({
    env: () => "ww_live_test",
    fetchImpl: async () => ({
      ok: false,
      status: 422,
      text: async () => '{"error":"barcodeValue exceeds 1024 characters"}'
    })
  });

  await assert.rejects(
    () => wallet.createPass({ guest, ticket, checkinUrl: CHECKIN }),
    /422.*barcodeValue exceeds/s
  );
});

test("the key is never put in a URL", async () => {
  // A query string ends up in logs and proxies. It belongs in the header.
  const wallet = createWallet({
    env: () => "ww_live_secret",
    fetchImpl: async (url) => {
      assert.doesNotMatch(url, /ww_live_secret/, "the key was put in the URL");
      return { ok: true, status: 200, text: async () => JSON.stringify({ serialNumber: "s" }) };
    }
  });
  await wallet.createPass({ guest, ticket, checkinUrl: CHECKIN });
});
