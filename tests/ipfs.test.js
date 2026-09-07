import { test } from "node:test";
import assert from "node:assert/strict";
import { createPinner, isImagePath, mimeFor } from "../admin/ipfs.js";

/**
 * No network. `fetchImpl` is injectable precisely so the tests never upload
 * anything to a real account, and never depend on a third party being up.
 */

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });
const fail = (status, text = "") => ({ ok: false, status, json: async () => ({}), text: async () => text });

test("only image extensions are pinned", () => {
  for (const yes of ["a.jpg", "a.JPEG", "b.png", "c.webp", "d.avif", "e.gif", "f.svg"]) {
    assert.equal(isImagePath(yes), true, yes);
  }
  for (const no of ["src/_data/faq.json", "admin/users.json", "a.pdf", "a.mp4", "noext"]) {
    assert.equal(isImagePath(no), false, no);
  }
});

test("the content type follows the extension", () => {
  assert.equal(mimeFor("a.jpg"), "image/jpeg");
  assert.equal(mimeFor("a.JPG"), "image/jpeg");
  assert.equal(mimeFor("a.svg"), "image/svg+xml");
  assert.equal(mimeFor("a.unknown"), "application/octet-stream");
});

test("without a credential it is not configured and refuses to pin", async () => {
  const pinner = createPinner({ jwt: "", fetchImpl: () => assert.fail("should not call out") });
  assert.equal(pinner.configured(), false);
  assert.deepEqual(await pinner.testAuth(), { ok: false, reason: "no PINATA_JWT" });
  await assert.rejects(() => pinner.pin({ buffer: Buffer.from([1]), filename: "a.png" }), /not configured/);
});

test("the credential is sent as a bearer token", async () => {
  let seen = null;
  const pinner = createPinner({
    jwt: "the-jwt",
    fetchImpl: async (url, init) => {
      seen = { url, auth: init?.headers?.Authorization, method: init?.method };
      return ok({ IpfsHash: "bafyTEST", PinSize: 3 });
    }
  });

  const result = await pinner.pin({ buffer: Buffer.from([1, 2, 3]), filename: "logo.png" });
  assert.equal(result.cid, "bafyTEST");
  assert.equal(seen.auth, "Bearer the-jwt");
  assert.equal(seen.method, "POST");
  assert.match(seen.url, /pinFileToIPFS$/);
});

test("the upload carries the file and its name", async () => {
  let body = null;
  const pinner = createPinner({
    jwt: "x",
    fetchImpl: async (_url, init) => {
      body = init.body;
      return ok({ IpfsHash: "bafy", PinSize: 3 });
    }
  });

  await pinner.pin({ buffer: Buffer.from([1, 2, 3]), filename: "rony-vogel.png" });
  assert.ok(body instanceof FormData);
  const file = body.get("file");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 3);
  assert.match(String(body.get("pinataMetadata")), /rony-vogel\.png/);
});

test("a rejected credential says so, rather than looking like a network fault", async () => {
  // 401 and 403 mean different things and need different fixes, so they get
  // different messages.
  const unauthorised = createPinner({ jwt: "stale", fetchImpl: async () => fail(401) });
  const forbidden = createPinner({ jwt: "readonly", fetchImpl: async () => fail(403) });

  assert.match((await unauthorised.testAuth()).reason, /revoked or truncated/);
  assert.match((await forbidden.testAuth()).reason, /lacks permission/);
  assert.equal((await unauthorised.testAuth()).ok, false);
});

test("a network failure during the check is reported, not thrown", async () => {
  const pinner = createPinner({
    jwt: "x",
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }
  });
  const result = await pinner.testAuth();
  assert.equal(result.ok, false);
  assert.match(result.reason, /ENOTFOUND/);
});

test("a failed pin surfaces the status and the response", async () => {
  const pinner = createPinner({
    jwt: "x",
    fetchImpl: async () => fail(413, '{"error":"file too large"}')
  });
  await assert.rejects(
    () => pinner.pin({ buffer: Buffer.alloc(9), filename: "big.png" }),
    /Pinata returned 413.*file too large/s
  );
});

test("an accepted upload with no CID is an error, not a silent success", async () => {
  // Recording an empty CID would mean the image counted as pinned and could
  // never be found again.
  const pinner = createPinner({ jwt: "x", fetchImpl: async () => ok({ PinSize: 3 }) });
  await assert.rejects(
    () => pinner.pin({ buffer: Buffer.from([1]), filename: "a.png" }),
    /returned no CID/
  );
});

test("the dedicated gateway is preferred, and normalised", async () => {
  // The public gateway is rate-limited, so it is a poor default for a link
  // anybody actually clicks.
  const bare = createPinner({ jwt: "x", gateway: "purple-ox.mypinata.cloud" });
  assert.equal(bare.gatewayUrl("bafy1"), "https://purple-ox.mypinata.cloud/ipfs/bafy1");

  // Tolerate what someone might paste, since the field says not to.
  for (const messy of ["https://purple-ox.mypinata.cloud", "purple-ox.mypinata.cloud/", "http://purple-ox.mypinata.cloud//"]) {
    const pinner = createPinner({ jwt: "x", gateway: messy });
    assert.equal(pinner.gatewayUrl("bafy1"), "https://purple-ox.mypinata.cloud/ipfs/bafy1", messy);
  }

  const none = createPinner({ jwt: "x", gateway: "" });
  assert.equal(none.gatewayUrl("bafy1"), "https://ipfs.io/ipfs/bafy1");
  assert.equal(none.gatewayUrl(null), null);
});

test("credentials are resolved on use, not at construction", async () => {
  // They live in the database and are loaded into the environment during
  // boot, which happens after this module is imported and the pinner built.
  const before = process.env.PINATA_JWT;
  delete process.env.PINATA_JWT;

  const pinner = createPinner({ fetchImpl: async () => ok({ IpfsHash: "bafy" }) });
  assert.equal(pinner.configured(), false, "configured before the credential arrived");

  process.env.PINATA_JWT = "arrived-later";
  assert.equal(pinner.configured(), true, "did not pick up the credential");

  if (before === undefined) delete process.env.PINATA_JWT;
  else process.env.PINATA_JWT = before;
});
