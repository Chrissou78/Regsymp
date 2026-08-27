import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../admin/schemas.js";

// The admin is disabled unless GITHUB_CLIENT_ID is set, and server.js reads
// it at module scope. Static imports are hoisted above these assignments, so
// the server must be imported dynamically *after* the environment is set.
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-secret";
process.env.ADMIN_ALLOWLIST = "test-user";
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
  assert.match(body, /Sign in with GitHub/);
  assert.match(body, /noindex, nofollow/);
});

test("starting OAuth redirects to GitHub with a state parameter", async () => {
  const res = await call("/admin/auth");
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location"));
  assert.equal(location.host, "github.com");
  assert.equal(location.searchParams.get("client_id"), "test-client-id");
  assert.ok(location.searchParams.get("state"), "state must be present");
});

test("the OAuth callback rejects a forged state", async () => {
  const res = await call("/admin/auth/callback?code=x&state=forged");
  assert.equal(res.status, 403);
  assert.match(await res.text(), /invalid or has expired/i);
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
