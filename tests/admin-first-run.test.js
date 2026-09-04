import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A fresh installation needs no token and no secret any more — only its first
 * account. This route creates it, and must stop existing the moment it has.
 */
const CONTENT_DIR = await mkdtemp(path.join(tmpdir(), "regsymp-first-"));
process.env.CONTENT_DIR = CONTENT_DIR;
process.env.SESSION_SECRET = "test-session-secret";
delete process.env.ADMIN_USERS; // no environment account: this is a blank slate

const { ensureContentDir } = await import("../admin/content-dir.js");
// Seed the data files but deliberately not the accounts file, so the volume
// starts with content and no admins — exactly a new installation.
await ensureContentDir({ dir: CONTENT_DIR, root: path.resolve("."), files: [] });

const { server } = await import("../server.js");

let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const call = (p, init) => fetch(base + p, { redirect: "manual", ...init });

const form = (fields) =>
  ({
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });

test("with no accounts, the admin sends you to create the first one", async () => {
  // Otherwise a new installation lands on a sign-in form nothing can satisfy.
  const res = await call("/admin");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin/first-run");

  const page = await (await call("/admin/first-run")).text();
  assert.match(page, /Create the first account/);
});

test("a weak or mistyped password is refused", async () => {
  const short = await call("/admin/first-run", form({
    email: "chris@example.com", password: "short", confirm: "short"
  }));
  assert.equal(short.status, 400);
  assert.match(await short.text(), /at least 12 characters/i);

  const mismatch = await call("/admin/first-run", form({
    email: "chris@example.com", password: "long-enough-password", confirm: "different-password"
  }));
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /do not match/i);
});

test("the first account is created and becomes the owner", async () => {
  const res = await call("/admin/first-run", form({
    email: "Chris@Example.com",
    password: "long-enough-password",
    confirm: "long-enough-password"
  }));
  assert.equal(res.status, 200);

  const stored = JSON.parse(await readFile(path.join(CONTENT_DIR, "admin/users.json"), "utf8"));
  assert.equal(stored.users.length, 1);
  assert.equal(stored.users[0].email, "chris@example.com", "the address is normalised");
  assert.ok(stored.users[0].hash.startsWith("scrypt$"), "the password is hashed, not stored");
  assert.ok(!JSON.stringify(stored).includes("long-enough-password"), "the password leaked");
});

test("the new owner can sign in", async () => {
  const res = await call("/admin/signin", form({
    email: "chris@example.com",
    password: "long-enough-password"
  }));
  assert.equal(res.status, 302);
  assert.ok((res.headers.get("set-cookie") ?? "").startsWith("regsymp_admin="));
});

test("once an account exists the route is gone, so nobody else can claim it", async () => {
  const res = await call("/admin/first-run");
  assert.equal(res.status, 404);

  const post = await call("/admin/first-run", form({
    email: "intruder@example.com",
    password: "long-enough-password",
    confirm: "long-enough-password"
  }));
  assert.equal(post.status, 404);

  const stored = JSON.parse(await readFile(path.join(CONTENT_DIR, "admin/users.json"), "utf8"));
  assert.equal(stored.users.length, 1, "a second account was created");
});
