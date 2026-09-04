import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The whole point of the volume, end to end: a save must land on disk and
 * appear in the built site immediately, with no commit and no redeploy.
 *
 * server.js reads CONTENT_DIR at module scope, so the environment has to be
 * set before it is imported. Static imports are hoisted, hence the dynamic
 * import below.
 */
const CONTENT_DIR = await mkdtemp(path.join(tmpdir(), "regsymp-save-"));
process.env.CONTENT_DIR = CONTENT_DIR;

const { hashPassword } = await import("../admin/password.js");
process.env.ADMIN_USERS = `admin@regsymp.com:${await hashPassword("correct-horse-battery")}`;
process.env.SESSION_SECRET = "test-session-secret";

const { ensureContentDir } = await import("../admin/content-dir.js");
const PROJECT_ROOT = path.resolve(".");
await ensureContentDir({ dir: CONTENT_DIR, root: PROJECT_ROOT });

const { server } = await import("../server.js");

const FAQ_SOURCE = path.join(PROJECT_ROOT, "src/_data/faq.json");
const original = await readFile(FAQ_SOURCE, "utf8");

let base;
let cookie;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/admin/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "email=admin%40regsymp.com&password=correct-horse-battery"
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith("regsymp_admin="), "sign-in did not issue a session");
});

// Saving writes through to the working tree by design, so put it back.
after(async () => {
  await writeFile(FAQ_SOURCE, original);
  await new Promise((resolve) => server.close(resolve));
});

const call = (p, init = {}) =>
  fetch(base + p, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });

/** The CSRF token embedded in a form. */
async function csrfFrom(p) {
  const body = await (await call(p)).text();
  const match = body.match(/name="csrf" value="([a-f0-9]+)"/);
  assert.ok(match, `no CSRF token on ${p}`);
  return match[1];
}

test("a save lands on the volume and in the built site, with no deploy", async () => {
  const question = `Volume round trip ${Date.now()}?`;
  const csrf = await csrfFrom("/admin/faq/new");

  const res = await call("/admin/faq/new", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrf,
      question,
      answer: "Saved straight to the content volume."
    }).toString()
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /is live now/);

  // 1. the volume is the source of truth
  const onVolume = JSON.parse(await readFile(path.join(CONTENT_DIR, "src/_data/faq.json"), "utf8"));
  assert.ok(onVolume.some((item) => item.question === question), "not written to the volume");

  // 2. the working tree was refreshed from it, so the next build agrees
  const inTree = JSON.parse(await readFile(FAQ_SOURCE, "utf8"));
  assert.ok(inTree.some((item) => item.question === question), "not copied to the working tree");

  // 3. and the site was already rebuilt, without anything being deployed
  const built = await readFile(path.join(PROJECT_ROOT, "_site/faq/index.html"), "utf8");
  assert.ok(built.includes(question), "the built page does not show the change");
});

test("the previous version is kept, so a bad edit can be undone", async () => {
  const { createFsStore } = await import("../admin/store-fs.js");
  const store = createFsStore({ dir: CONTENT_DIR });

  const revisions = await store.listRevisions("src/_data/faq.json");
  assert.ok(revisions.length >= 1, "no previous version was kept");

  const previous = JSON.parse(await store.readRevision("src/_data/faq.json", revisions[0]));
  assert.ok(Array.isArray(previous), "the kept version is not readable content");
});

test("saving never signs anybody out", async () => {
  // The old path committed, which redeployed, which replaced the container and
  // destroyed every session. The same cookie must still work afterwards.
  const res = await call("/admin");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Collections/);
});
