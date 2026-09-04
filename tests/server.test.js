import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.js";

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const get = (p, init) => fetch(base + p, { redirect: "manual", ...init });

// ------------------------------------------------------------------ static

test("serves the homepage", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /RegSymp/);
  assert.match(html, /id="inviteModal"/);
});

test("serves each page at its clean URL", async () => {
  for (const p of [
    "/speakers",
    "/partners",
    "/faq",
    "/legal",
    "/pillars",
    "/london-2027",
    "/luxembourg-2027",
    "/sitemap.xml",
    "/robots.txt"
  ]) {
    const res = await get(p);
    assert.equal(res.status, 200, `${p} returned ${res.status}`);
  }
});

// ---------------------------------------------------------------- redirects

test("redirects .html to the clean URL, as vercel.json did", async () => {
  const res = await get("/speakers.html");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "/speakers");
});

test("strips a trailing slash", async () => {
  const res = await get("/speakers/");
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("location"), "/speakers");
});

test("preserves the query string across a redirect", async () => {
  const res = await get("/speakers.html?utm_source=li");
  assert.equal(res.headers.get("location"), "/speakers?utm_source=li");
});

// ------------------------------------------------------------------ caching

test("content-hashed assets are cached hard, HTML is not", async () => {
  const html = await get("/");
  assert.match(html.headers.get("cache-control"), /must-revalidate/);

  // Find a real generated image; only /img/ filenames carry a content hash.
  const hashed = (await (await get("/")).text()).match(/\/img\/[A-Za-z0-9_-]+\.[a-z]+/);
  assert.ok(hashed, "expected at least one generated image on the homepage");

  const img = await get(hashed[0]);
  assert.equal(img.status, 200);
  assert.match(img.headers.get("cache-control"), /immutable/);
  assert.match(img.headers.get("cache-control"), /max-age=31536000/);
});

test("honours If-None-Match with a 304", async () => {
  const first = await get("/assets/css/styles.css");
  const etag = first.headers.get("etag");
  assert.ok(etag, "no ETag issued");
  const second = await get("/assets/css/styles.css", { headers: { "If-None-Match": etag } });
  assert.equal(second.status, 304);
});

test("HEAD returns headers without a body", async () => {
  const res = await get("/", { method: "HEAD" });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).length, 0);
});

// ----------------------------------------------------------------- security

test("rejects path traversal", async () => {
  for (const p of [
    "/../package.json",
    "/..%2f..%2fpackage.json",
    "/assets/../../package.json"
  ]) {
    const res = await get(p);
    assert.ok(res.status === 404 || res.status === 308 || res.status === 400,
      `${p} returned ${res.status}`);
    if (res.status === 200) {
      const body = await res.text();
      assert.doesNotMatch(body, /"name": "regsymp"/, `${p} leaked package.json`);
    }
  }
});

test("unknown paths 404", async () => {
  const res = await get("/no-such-page");
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------- API

test("invitation endpoint rejects GET", async () => {
  const res = await get("/api/request-invitation");
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("invitation endpoint validates before sending", async () => {
  const res = await get("/api/request-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane",
      email: "jane@example.com",
      company: "Acme",
      role: "",
      consent: "yes"
    })
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "Please provide your role." });
});

test("invitation endpoint rejects a filled honeypot", async () => {
  const res = await get("/api/request-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane",
      email: "jane@example.com",
      company: "Acme",
      role: "CTO",
      consent: "yes",
      website: "http://spam.example"
    })
  });
  assert.equal(res.status, 400);
});

test("invitation endpoint fails gracefully when Resend is unconfigured", async () => {
  const res = await get("/api/request-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jane",
      email: "jane@example.com",
      company: "Acme",
      role: "CTO",
      consent: "yes"
    })
  });
  // 502 without credentials, 200 if a real key happens to be present
  assert.ok([200, 502].includes(res.status), `unexpected ${res.status}`);
  if (res.status === 502) {
    assert.match((await res.json()).error, /Please email info@regsymp\.com/);
  }
});

test("malformed JSON does not crash the endpoint", async () => {
  const res = await get("/api/request-invitation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json"
  });
  assert.equal(res.status, 400);
});

test("unknown API routes 404 as JSON", async () => {
  const res = await get("/api/nope");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /application\/json/);
});

// -------------------------------------------------------------------- health

test("health reports config presence without leaking values", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  for (const key of ["RESEND_API_KEY", "RESEND_FROM", "INVITATION_RECIPIENT"]) {
    assert.equal(typeof body.config[key], "boolean", `${key} should be a boolean`);
  }
  // the actual secret must never appear in the response
  const raw = JSON.stringify(body);
  assert.doesNotMatch(raw, /re_[A-Za-z0-9]/, "response leaked an API key");
  if (process.env.RESEND_API_KEY) {
    assert.ok(!raw.includes(process.env.RESEND_API_KEY), "response leaked the API key");
  }
});

test("only content-hashed assets are cached immutably", async () => {
  // /img/ filenames carry a content hash, so they may be cached for a year.
  // /assets/ has stable filenames — caching those immutably meant a CSS or
  // JS change never reached a returning visitor.
  const css = await get("/assets/css/styles.css");
  assert.equal(css.status, 200);
  assert.doesNotMatch(
    css.headers.get("cache-control"),
    /immutable/,
    "styles.css has a stable filename and must revalidate"
  );
  assert.match(css.headers.get("cache-control"), /must-revalidate/);

  const js = await get("/assets/js/site.js");
  assert.doesNotMatch(js.headers.get("cache-control"), /immutable/);
});

test("health reports whether the admin code is present and configured", async () => {
  const body = await (await get("/api/health")).json();
  assert.equal(body.adminMounted, true, "absence of this field means old code is running");
  assert.equal(typeof body.adminConfigured, "boolean");
});

test("health does no network I/O unless asked", async () => {
  // A health endpoint that waits on GitHub looks unhealthy whenever GitHub is
  // slow, which on a platform that probes this route means a restart loop.
  const started = Date.now();
  const res = await get("/api/health");
  const elapsed = Date.now() - started;

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!("content" in body), "the repo check must be opt-in");
  assert.ok(elapsed < 500, `health took ${elapsed}ms; it must not wait on a third party`);
});

test("the repo check is available on request", async () => {
  const body = await (await get("/api/health?content=1")).json();
  assert.ok("content" in body);
  assert.equal(typeof body.content.readable, "boolean");
});
