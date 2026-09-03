import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../admin/schemas.js";

// The admin is disabled unless ADMIN_USERS is set, and server.js reads it at
// module scope. Static imports are hoisted above these assignments, so the
// server must be imported dynamically *after* the environment is set.
// A real scrypt hash for the password "correct-horse-battery" so the
// sign-in route can be exercised end to end.
const { hashPassword } = await import("../admin/password.js");
process.env.ADMIN_USERS = `admin@regsymp.com:${await hashPassword("correct-horse-battery")}`;
process.env.GITHUB_TOKEN = "test-github-token";
process.env.SESSION_SECRET = "test-session-secret";

const { server } = await import("../server.js");

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const call = (path, init) => fetch(base + path, { redirect: "manual", ...init });

test("every admin route requires a session", async () => {
  const guarded = [["GET", "/admin"], ["GET", "/admin/nonexistent"]];

  // Derive the route list from the schemas so a collection added later is
  // covered automatically rather than being silently unguarded.
  for (const name of Object.keys(SCHEMAS)) {
    guarded.push(["GET", `/admin/${name}`]);
    guarded.push(["GET", `/admin/${name}/0`]);
    guarded.push(["GET", `/admin/${name}/new`]);
    guarded.push(["POST", `/admin/${name}/0`]);
    guarded.push(["POST", `/admin/${name}/0/delete`]);
    guarded.push(["POST", `/admin/${name}/0/move`]);
  }

  for (const [method, path] of guarded) {
    const res = await call(path, { method });
    assert.ok(
      [302, 401, 403].includes(res.status),
      `${method} ${path} returned ${res.status} without a session`
    );
    if (res.status === 302) {
      assert.equal(res.headers.get("location"), "/admin/signin", `${method} ${path}`);
    }
  }
});

test("the sign-in page is reachable without a session", async () => {
  const res = await call("/admin/signin");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /RegSymp Admin/);
  assert.match(body, /Sign in/);
  assert.match(body, /noindex, nofollow/);
});

test("the sign-in form is a normal email and password form", async () => {
  const body = await (await call("/admin/signin")).text();
  assert.match(body, /name="email"/);
  assert.match(body, /name="password"/);
  assert.match(body, /type="password"/);
  assert.doesNotMatch(body, /github\.com/i, "no OAuth flow should remain");
});

test("wrong credentials are rejected without revealing which part was wrong", async () => {
  const wrongPassword = await call("/admin/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=admin@regsymp.com&password=nope"
  });
  const unknownUser = await call("/admin/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=nobody@example.com&password=nope"
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  const a = await wrongPassword.text();
  const b = await unknownUser.text();
  assert.match(a, /do not match/);
  assert.equal(
    a.replace(/\s+/g, ""),
    b.replace(/\s+/g, ""),
    "both failures must look identical, or the form enumerates accounts"
  );
});

test("correct credentials issue a session cookie", async () => {
  const res = await call("/admin/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=admin@regsymp.com&password=correct-horse-battery"
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/admin");

  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /regsymp_admin=[a-f0-9]{32,}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test("a signed-in session reaches the collections index", async () => {
  const login = await call("/admin/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=admin@regsymp.com&password=correct-horse-battery"
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const res = await call("/admin", { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Collections/);
  assert.match(body, /admin@regsymp\.com/, "the signed-in account is shown");
  for (const label of ["Speakers", "Partners", "FAQ"]) {
    assert.ok(body.includes(label), `missing ${label}`);
  }
});

test("the session cookie never carries the GitHub token", async () => {
  const res = await call("/admin/signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=admin@regsymp.com&password=correct-horse-battery"
  });
  const cookie = res.headers.get("set-cookie");
  assert.ok(!cookie.includes("test-github-token"), "the token must stay server-side");
});

test("admin responses are never cached", async () => {
  const res = await call("/admin/signin");
  assert.match(res.headers.get("cache-control"), /no-store/);
});

test("admin is excluded from robots.txt", async () => {
  const res = await fetch(base + "/robots.txt");
  assert.match(await res.text(), /Disallow: \/admin/);
});

test("the public site is unaffected by mounting the admin", async () => {
  for (const path of ["/", "/speakers", "/partners", "/faq", "/api/health"]) {
    const res = await call(path);
    assert.equal(res.status, 200, `${path} returned ${res.status}`);
  }
  const notFound = await call("/no-such-page");
  assert.equal(notFound.status, 404);
});

test("the admin stylesheet is served", async () => {
  const res = await call("/assets/css/admin.css");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/css/);
});
