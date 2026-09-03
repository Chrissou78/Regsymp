import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, parseUsers } from "../admin/password.js";
import { createAttemptLimiter } from "../admin/login-attempts.js";

test("a password verifies against its own hash and nothing else", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("", hash), false);
});

test("the same password hashes differently every time", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a, b, "a per-hash salt must make these differ");
  assert.equal(await verifyPassword("same password", a), true);
  assert.equal(await verifyPassword("same password", b), true);
});

test("the hash never contains the password", async () => {
  const hash = await hashPassword("supersecretvalue");
  assert.ok(!hash.includes("supersecretvalue"));
  assert.match(hash, /^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);
});

test("a malformed or missing hash rejects rather than throwing", async () => {
  for (const bad of ["", "notahash", "scrypt$only-two", undefined, null, "md5$a$b"]) {
    assert.equal(await verifyPassword("anything", bad), false, `input ${JSON.stringify(bad)}`);
  }
});

test("parseUsers reads valid entries and ignores junk", async () => {
  const hash = await hashPassword("x".repeat(12));
  const users = parseUsers(`  Chris@Example.com:${hash} , bad-entry, nohash@example.com:plain `);

  assert.equal(users.size, 1, "only the well-formed entry is kept");
  assert.ok(users.has("chris@example.com"), "emails are lowercased");
  assert.equal(users.get("chris@example.com"), hash);
});

test("an empty or missing ADMIN_USERS admits nobody", () => {
  for (const value of ["", "   ", undefined, null, ",,,"]) {
    assert.equal(parseUsers(value).size, 0, `input ${JSON.stringify(value)}`);
  }
});

test("multiple accounts are supported", async () => {
  const a = await hashPassword("password-one-1");
  const b = await hashPassword("password-two-2");
  const users = parseUsers(`one@example.com:${a},two@example.com:${b}`);
  assert.equal(users.size, 2);
  assert.equal(await verifyPassword("password-one-1", users.get("one@example.com")), true);
  assert.equal(await verifyPassword("password-one-1", users.get("two@example.com")), false);
});

// ------------------------------------------------------------- throttling

test("a source is locked out after repeated failures", () => {
  const limiter = createAttemptLimiter({ maxAttempts: 3, windowMs: 60_000 });
  assert.equal(limiter.isLocked("1.2.3.4"), false);
  limiter.fail("1.2.3.4");
  limiter.fail("1.2.3.4");
  assert.equal(limiter.isLocked("1.2.3.4"), false, "still under the limit");
  limiter.fail("1.2.3.4");
  assert.equal(limiter.isLocked("1.2.3.4"), true);
  assert.ok(limiter.retryAfter("1.2.3.4") > 0);
});

test("lockout is per source, not global", () => {
  const limiter = createAttemptLimiter({ maxAttempts: 2, windowMs: 60_000 });
  limiter.fail("1.1.1.1");
  limiter.fail("1.1.1.1");
  assert.equal(limiter.isLocked("1.1.1.1"), true);
  assert.equal(limiter.isLocked("2.2.2.2"), false, "one attacker must not lock everyone out");
});

test("a successful sign-in clears the counter", () => {
  const limiter = createAttemptLimiter({ maxAttempts: 2, windowMs: 60_000 });
  limiter.fail("1.1.1.1");
  limiter.succeed("1.1.1.1");
  limiter.fail("1.1.1.1");
  assert.equal(limiter.isLocked("1.1.1.1"), false);
});

test("the window expires", () => {
  let now = 1000;
  const limiter = createAttemptLimiter({ maxAttempts: 1, windowMs: 500, now: () => now });
  limiter.fail("1.1.1.1");
  assert.equal(limiter.isLocked("1.1.1.1"), true);
  now += 600;
  assert.equal(limiter.isLocked("1.1.1.1"), false, "the lock must lift after the window");
  assert.equal(limiter.size(), 0, "expired records are pruned");
});
