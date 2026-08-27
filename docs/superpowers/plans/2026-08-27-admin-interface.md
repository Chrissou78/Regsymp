# Admin Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An authenticated `/admin` interface, served by the existing `server.js`, that manages every `src/_data/` file and its images, committing each change to git.

**Architecture:** Schema-driven. One declarative description per collection drives the list view, form, validation and write. Auth is GitHub OAuth with a username allowlist and server-side sessions. Writes go straight to `OC-Labs/regsymp@prod` through the GitHub Contents API — nothing touches the container's ephemeral filesystem.

**Tech Stack:** Node 22, ESM, `node:test`, no new runtime dependencies. Server-rendered HTML, no client framework.

## Global Constraints

- **No new runtime dependencies.** Node built-ins plus the existing `resend`.
- **ESM only.** `package.json` sets `"type": "module"`.
- **`prod` is never force-pushed again.** Code flows `origin/main` → merged into `prod` → pushed without `--force`.
- Commit target is configurable: `CONTENT_REPO` (default `OC-Labs/regsymp`), `CONTENT_BRANCH` (default `prod`).
- The OAuth token never reaches the browser. Sessions are server-side; the cookie holds an opaque id only.
- Uploaded filenames are always slugified. This is not optional — case and space mismatches previously 404'd four speaker photos and every carousel image on Linux.
- Every admin route except `/admin/signin`, `/admin/auth`, `/admin/auth/callback` requires a session.
- British English in all user-facing copy.
- Commit after every task. Never use `--no-verify`.

---

### Task 1: Sanitising — filenames and HTML

Pure functions, no I/O. Built first because everything else depends on them and because slugification is the single highest-value piece of this feature.

**Files:**
- Create: `admin/sanitise.js`
- Test: `tests/admin-sanitise.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `slugifyFilename(name) -> string`, `slugify(text) -> string`, `sanitiseHtml(html, allowedTags) -> string`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugifyFilename, slugify, sanitiseHtml } from "../admin/sanitise.js";

test("slugifyFilename normalises the names that broke production", () => {
  const cases = [
    ["Rony Vogel.png", "rony-vogel.png"],
    ["Martín L. Aleñar Feliu..jpg", "martin-l-alenar-feliu.jpg"],
    ["Lloyd Nelson III .jpeg", "lloyd-nelson-iii.jpg"],
    ["Matthias_Wyss_CEO (2).jpg", "matthias-wyss-ceo-2.jpg"],
    ["LMAXGroup-BlackOn-RedChevron-Horizontal.png", "lmaxgroup-blackon-redchevron-horizontal.png"],
    ["Alberto Bank of Spain.jpeg", "alberto-bank-of-spain.jpg"],
    ["already-fine.webp", "already-fine.webp"],
    ["UPPER.PNG", "upper.png"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(slugifyFilename(input), expected, `input ${JSON.stringify(input)}`);
  }
});

test("slugifyFilename rejects a name with no usable characters", () => {
  assert.throws(() => slugifyFilename("...jpg"), /filename/i);
  assert.throws(() => slugifyFilename(""), /filename/i);
});

test("slugify makes record slugs", () => {
  assert.equal(slugify("Barbara Pozdorovkina"), "barbara-pozdorovkina");
  assert.equal(slugify("Martín L. Aleñar Feliu"), "martin-l-alenar-feliu");
  assert.equal(slugify("  Spaced  Out  "), "spaced-out");
});

test("sanitiseHtml keeps the allowlist and drops everything else", () => {
  const allow = ["strong", "em", "br"];
  assert.equal(
    sanitiseHtml("<strong>Bold</strong>, plain", allow),
    "<strong>Bold</strong>, plain"
  );
  assert.equal(sanitiseHtml("<script>alert(1)</script>hi", allow), "hi");
  assert.equal(sanitiseHtml('<img src=x onerror="alert(1)">', allow), "");
  // attributes are stripped even from allowed tags
  assert.equal(sanitiseHtml('<strong class="x">a</strong>', allow), "<strong>a</strong>");
  assert.equal(sanitiseHtml('<a href="javascript:alert(1)">x</a>', allow), "x");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-sanitise.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
const EXT_ALIASES = { jpeg: "jpg" };

function asciiFold(text) {
  return String(text).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function slugify(text) {
  const out = asciiFold(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out;
}

export function slugifyFilename(name) {
  const raw = String(name ?? "").trim();
  const lastDot = raw.lastIndexOf(".");
  const stem = lastDot > 0 ? raw.slice(0, lastDot) : raw;
  let ext = lastDot > 0 ? raw.slice(lastDot + 1) : "";

  ext = slugify(ext);
  ext = EXT_ALIASES[ext] ?? ext;

  const base = slugify(stem);
  if (!base || !ext) throw new Error(`Unusable filename: ${JSON.stringify(name)}`);
  return `${base}.${ext}`;
}

export function sanitiseHtml(html, allowedTags = []) {
  const allowed = new Set(allowedTags.map((t) => t.toLowerCase()));
  let out = String(html ?? "");

  // Remove whole elements whose content must not survive.
  out = out.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, "");
  // Remove any remaining tags, keeping allowed ones without attributes.
  out = out.replace(/<\/?([a-zA-Z0-9-]+)\b[^>]*>/g, (match, tag) => {
    const name = tag.toLowerCase();
    if (!allowed.has(name)) return "";
    return match.startsWith("</") ? `</${name}>` : `<${name}>`;
  });
  // Self-closing leftovers of disallowed tags are already gone.
  return out.trim();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/admin-sanitise.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add admin/sanitise.js tests/admin-sanitise.test.js
git commit -m "Add filename and HTML sanitising for the admin"
```

---

### Task 2: Collection schemas and validation

**Files:**
- Create: `admin/schemas.js`
- Test: `tests/admin-schemas.test.js`

**Interfaces:**
- Consumes: `slugify`, `sanitiseHtml` from `admin/sanitise.js`.
- Produces: `SCHEMAS` (object keyed by collection name), `validateRecord(schema, input) -> {ok, value, errors}`, `getSchema(name) -> schema | undefined`.

Schema object shape: `{ file, kind: "array"|"object"|"nested", label, identify(record), fields: [...] }`.
Field shape: `{ name, type, required?, max?, unique?, from?, allow?, dir?, options?, help? }`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS, getSchema, validateRecord } from "../admin/schemas.js";

test("every data file has a schema pointing at a real path", () => {
  const files = Object.values(SCHEMAS).map((s) => s.file);
  for (const expected of [
    "src/_data/speakers.json",
    "src/_data/partners.json",
    "src/_data/faq.json",
    "src/_data/themes.json",
    "src/_data/editions.json",
    "src/_data/agenda.json",
    "src/_data/site.json"
  ]) {
    assert.ok(files.includes(expected), `no schema for ${expected}`);
  }
});

test("speakers: required fields are enforced", () => {
  const s = getSchema("speakers");
  const r = validateRecord(s, { name: "", role: "CEO" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "name"));
});

test("speakers: a slug is derived from the name when absent", () => {
  const s = getSchema("speakers");
  const r = validateRecord(s, { name: "Barbara Pozdorovkina", role: "CGO" });
  assert.equal(r.ok, true);
  assert.equal(r.value.slug, "barbara-pozdorovkina");
});

test("speakers: html fields are sanitised, not rejected", () => {
  const s = getSchema("speakers");
  const r = validateRecord(s, {
    name: "X",
    role: "Y",
    orgHtml: '<strong>Dept</strong><script>alert(1)</script>'
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.orgHtml, "<strong>Dept</strong>");
});

test("max length is enforced", () => {
  const s = getSchema("speakers");
  const r = validateRecord(s, { name: "x".repeat(500), role: "Y" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "name" && /long/i.test(e.message)));
});

test("url fields reject non-http schemes", () => {
  const s = getSchema("speakers");
  for (const bad of ["javascript:alert(1)", "ftp://x", "not a url"]) {
    const r = validateRecord(s, { name: "X", role: "Y", linkedin: bad });
    assert.equal(r.ok, false, `${bad} should be rejected`);
  }
  const good = validateRecord(s, {
    name: "X",
    role: "Y",
    linkedin: "https://www.linkedin.com/in/x/"
  });
  assert.equal(good.ok, true);
});

test("empty optional fields are omitted rather than stored as empty strings", () => {
  const s = getSchema("speakers");
  const r = validateRecord(s, { name: "X", role: "Y", bio: "", linkedin: "" });
  assert.equal(r.ok, true);
  assert.ok(!("bio" in r.value));
  assert.ok(!("linkedin" in r.value));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-schemas.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
import { slugify, sanitiseHtml } from "./sanitise.js";

const F = (name, type, extra = {}) => ({ name, type, ...extra });

export const SCHEMAS = {
  speakers: {
    file: "src/_data/speakers.json",
    kind: "array",
    label: "Speakers",
    identify: (r) => r.name,
    fields: [
      F("slug", "slug", { from: "name", unique: true }),
      F("name", "text", { required: true, max: 120 }),
      F("role", "text", { required: true, max: 160 }),
      F("org", "text", { max: 200 }),
      F("orgHtml", "html", { allow: ["strong", "em", "br"], max: 400,
        help: "Optional. Emphasise part of the organisation name." }),
      F("bio", "textarea", { max: 2000 }),
      F("photo", "image", { dir: "src/assets/images/speakers" }),
      F("linkedin", "url", { max: 300 })
    ]
  },
  partners: {
    file: "src/_data/partners.json",
    kind: "nested",
    label: "Partners",
    identify: (r) => r.label,
    childKey: "logos",
    fields: [
      F("tier", "text", { required: true, max: 60, help: "CSS class, e.g. session-partner" }),
      F("label", "text", { required: true, max: 60 })
    ],
    childFields: [
      F("name", "text", { required: true, max: 120 }),
      F("file", "image", { dir: "src/assets/images", required: true }),
      F("modifier", "text", { max: 60, help: "Optional CSS class for bespoke sizing." })
    ]
  },
  faq: {
    file: "src/_data/faq.json",
    kind: "array",
    label: "FAQ",
    identify: (r) => r.question,
    fields: [
      F("question", "text", { required: true, max: 200 }),
      F("answer", "textarea", { required: true, max: 2000 })
    ]
  },
  themes: {
    file: "src/_data/themes.json",
    kind: "array",
    label: "Programme themes",
    identify: (r) => r.title,
    fields: [
      F("num", "text", { required: true, max: 4 }),
      F("title", "text", { required: true, max: 120 }),
      F("description", "textarea", { required: true, max: 600 })
    ]
  },
  editions: {
    file: "src/_data/editions.json",
    kind: "array",
    label: "Editions",
    identify: (r) => r.label,
    fields: [
      F("key", "text", { required: true, max: 40 }),
      F("label", "text", { required: true, max: 80 }),
      F("url", "text", { required: true, max: 120 })
    ]
  },
  agenda: {
    file: "src/_data/agenda.json",
    kind: "agenda",
    label: "Agenda",
    identify: (r) => r.title,
    fields: [
      F("time", "text", { required: true, max: 10 }),
      F("title", "text", { required: true, max: 200 }),
      F("badge", "text", { max: 60 }),
      F("break", "checkbox")
    ]
  },
  site: {
    file: "src/_data/site.json",
    kind: "object",
    label: "Site settings",
    identify: () => "Site settings",
    fields: [
      F("name", "text", { required: true, max: 80 }),
      F("url", "url", { required: true, max: 200 }),
      F("email", "text", { required: true, max: 200 }),
      F("linkedin", "url", { max: 300 }),
      F("twitter", "url", { max: 300 }),
      F("legalName", "text", { required: true, max: 120 }),
      F("themeColor", "text", { required: true, max: 20 }),
      F("defaultOgImage", "text", { required: true, max: 200 })
    ]
  }
};

export function getSchema(name) {
  return SCHEMAS[name];
}

function checkUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateRecord(schema, input, fields = schema.fields) {
  const errors = [];
  const value = {};

  for (const field of fields) {
    let raw = input[field.name];

    if (field.type === "checkbox") {
      if (raw === true || raw === "on" || raw === "true") value[field.name] = true;
      continue;
    }

    raw = typeof raw === "string" ? raw.trim() : raw ?? "";

    if (!raw && field.type === "slug" && field.from) {
      raw = slugify(String(input[field.from] ?? ""));
    }

    if (!raw) {
      if (field.required) errors.push({ field: field.name, message: `${field.name} is required.` });
      continue;
    }

    if (field.max && String(raw).length > field.max) {
      errors.push({ field: field.name, message: `${field.name} is too long (max ${field.max}).` });
      continue;
    }

    if (field.type === "url" && !checkUrl(raw)) {
      errors.push({ field: field.name, message: `${field.name} must be a http(s) URL.` });
      continue;
    }

    if (field.type === "slug") raw = slugify(raw);
    if (field.type === "html") raw = sanitiseHtml(raw, field.allow ?? []);

    if (raw !== "") value[field.name] = raw;
  }

  return { ok: errors.length === 0, value, errors };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/admin-schemas.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add admin/schemas.js tests/admin-schemas.test.js
git commit -m "Add admin collection schemas and validation"
```

---

### Task 3: GitHub Contents API client

**Files:**
- Create: `admin/github.js`
- Test: `tests/admin-github.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createClient({token, repo, branch, fetchImpl}) -> {getFile(path), putFile({path, content, message, sha, isBinary})}`.
  `getFile` resolves `{content: string, sha: string}` or `null` when absent.
  `putFile` resolves `{commit: {sha, htmlUrl}}` and throws `ConflictError` on a 409/422 SHA mismatch.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, ConflictError } from "../admin/github.js";

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[Object.keys(routes).find((k) => url.includes(k))];
    if (!handler) return { ok: false, status: 404, json: async () => ({}) };
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

test("getFile decodes base64 content and returns the sha", async () => {
  const { fetchImpl } = stub({
    "src/_data/speakers.json": async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: Buffer.from('[{"a":1}]').toString("base64"), sha: "abc123" })
    })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  const file = await gh.getFile("src/_data/speakers.json");
  assert.equal(file.content, '[{"a":1}]');
  assert.equal(file.sha, "abc123");
});

test("getFile returns null for a missing file", async () => {
  const { fetchImpl } = stub({});
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  assert.equal(await gh.getFile("nope.json"), null);
});

test("putFile targets the configured repo and branch and encodes content", async () => {
  const { fetchImpl, calls } = stub({
    "contents/": async () => ({
      ok: true,
      status: 200,
      json: async () => ({ commit: { sha: "deadbeef", html_url: "https://github.com/x" } })
    })
  });
  const gh = createClient({ token: "t", repo: "OC-Labs/regsymp", branch: "prod", fetchImpl });
  const res = await gh.putFile({
    path: "src/_data/faq.json",
    content: '[{"q":1}]',
    message: "update faq",
    sha: "old"
  });
  assert.equal(res.commit.sha, "deadbeef");

  const call = calls.at(-1);
  assert.ok(call.url.includes("/repos/OC-Labs/regsymp/contents/src/_data/faq.json"));
  const body = JSON.parse(call.init.body);
  assert.equal(body.branch, "prod");
  assert.equal(body.sha, "old");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), '[{"q":1}]');
});

test("a sha mismatch raises ConflictError rather than reporting success", async () => {
  const { fetchImpl } = stub({
    "contents/": async () => ({ ok: false, status: 409, json: async () => ({ message: "conflict" }) })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  await assert.rejects(
    () => gh.putFile({ path: "a.json", content: "{}", message: "m", sha: "stale" }),
    ConflictError
  );
});

test("other failures throw with the API message", async () => {
  const { fetchImpl } = stub({
    "contents/": async () => ({ ok: false, status: 500, json: async () => ({ message: "boom" }) })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  await assert.rejects(() => gh.putFile({ path: "a.json", content: "{}", message: "m" }), /boom/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-github.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
const API = "https://api.github.com";

export class ConflictError extends Error {
  constructor(message = "The file changed since you loaded it.") {
    super(message);
    this.name = "ConflictError";
  }
}

export function createClient({ token, repo, branch, fetchImpl = fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "regsymp-admin"
  };

  async function getFile(path) {
    const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      content: Buffer.from(body.content ?? "", "base64").toString("utf8"),
      sha: body.sha
    };
  }

  async function putFile({ path, content, message, sha, isBinary = false }) {
    const url = `${API}/repos/${repo}/contents/${path}`;
    const encoded = isBinary
      ? Buffer.from(content).toString("base64")
      : Buffer.from(content, "utf8").toString("base64");

    const res = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: encoded, branch, ...(sha ? { sha } : {}) })
    });

    if (res.ok) {
      const body = await res.json();
      return { commit: { sha: body.commit?.sha, htmlUrl: body.commit?.html_url } };
    }

    const err = await res.json().catch(() => ({}));
    if (res.status === 409 || res.status === 422) throw new ConflictError(err.message);
    throw new Error(err.message || `GitHub returned ${res.status}`);
  }

  return { getFile, putFile };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/admin-github.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add admin/github.js tests/admin-github.test.js
git commit -m "Add GitHub Contents API client for admin writes"
```

---

### Task 4: Authentication — OAuth, sessions, CSRF

**Files:**
- Create: `admin/auth.js`
- Test: `tests/admin-auth.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createSessions()` → `{create(user, token), get(id), destroy(id), size()}`;
  `csrfToken(sessionId, secret)`, `verifyCsrf(sessionId, token, secret)`;
  `isAllowed(login, allowlist)`; `authorizeUrl({clientId, redirectUri, state})`;
  `parseCookies(header)`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessions, csrfToken, verifyCsrf, isAllowed, authorizeUrl, parseCookies
} from "../admin/auth.js";

test("sessions round-trip and can be destroyed", () => {
  const s = createSessions();
  const id = s.create({ login: "chrissou78" }, "gh_token");
  assert.match(id, /^[a-f0-9]{32,}$/);
  assert.equal(s.get(id).user.login, "chrissou78");
  assert.equal(s.get(id).token, "gh_token");
  s.destroy(id);
  assert.equal(s.get(id), undefined);
});

test("expired sessions are not returned", () => {
  const s = createSessions({ ttlMs: -1 });
  const id = s.create({ login: "x" }, "t");
  assert.equal(s.get(id), undefined);
});

test("the allowlist is exact and case-insensitive", () => {
  assert.equal(isAllowed("chrissou78", "chrissou78,other"), true);
  assert.equal(isAllowed("CHRISSOU78", "chrissou78"), true);
  assert.equal(isAllowed("chrissou7", "chrissou78"), false);
  assert.equal(isAllowed("evil", "chrissou78"), false);
  assert.equal(isAllowed("anyone", ""), false, "an empty allowlist must permit nobody");
});

test("csrf tokens are bound to the session", () => {
  const a = csrfToken("session-a", "secret");
  assert.equal(verifyCsrf("session-a", a, "secret"), true);
  assert.equal(verifyCsrf("session-b", a, "secret"), false);
  assert.equal(verifyCsrf("session-a", a, "other-secret"), false);
  assert.equal(verifyCsrf("session-a", "garbage", "secret"), false);
  assert.equal(verifyCsrf("session-a", "", "secret"), false);
});

test("authorizeUrl carries client id, redirect and state", () => {
  const url = new URL(authorizeUrl({
    clientId: "cid", redirectUri: "https://regsymp.com/admin/auth/callback", state: "st"
  }));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("scope"), "repo");
});

test("parseCookies handles multiple values", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-auth.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const EIGHT_HOURS = 8 * 60 * 60 * 1000;

export function createSessions({ ttlMs = EIGHT_HOURS } = {}) {
  const store = new Map();

  function sweep() {
    const now = Date.now();
    for (const [id, s] of store) if (s.expires <= now) store.delete(id);
  }

  return {
    create(user, token) {
      sweep();
      const id = randomBytes(24).toString("hex");
      store.set(id, { user, token, expires: Date.now() + ttlMs });
      return id;
    },
    get(id) {
      if (!id) return undefined;
      const s = store.get(id);
      if (!s) return undefined;
      if (s.expires <= Date.now()) {
        store.delete(id);
        return undefined;
      }
      return s;
    },
    destroy(id) {
      store.delete(id);
    },
    size() {
      sweep();
      return store.size;
    }
  };
}

export function csrfToken(sessionId, secret) {
  return createHmac("sha256", String(secret)).update(String(sessionId)).digest("hex");
}

export function verifyCsrf(sessionId, token, secret) {
  const expected = csrfToken(sessionId, secret);
  const given = String(token ?? "");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

export function isAllowed(login, allowlist) {
  const names = String(allowlist ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return false;
  return names.includes(String(login ?? "").toLowerCase());
}

export function authorizeUrl({ clientId, redirectUri, state }) {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "repo");
  u.searchParams.set("state", state);
  return u.toString();
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/admin-auth.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add admin/auth.js tests/admin-auth.test.js
git commit -m "Add admin authentication primitives"
```

---

### Task 5: HTML rendering

**Files:**
- Create: `admin/render.js`
- Test: `tests/admin-render.test.js`

**Interfaces:**
- Consumes: schema field definitions from `admin/schemas.js`.
- Produces: `layout({title, user, body}) -> string`, `field(def, value) -> string`, `escape(text) -> string`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { layout, field, escape } from "../admin/render.js";

test("escape neutralises HTML", () => {
  assert.equal(escape('<script>"x"</script>'), "&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  assert.equal(escape(undefined), "");
});

test("layout produces a complete document", () => {
  const html = layout({ title: "Speakers", user: { login: "chrissou78" }, body: "<p>hi</p>" });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Speakers — RegSymp Admin<\/title>/);
  assert.match(html, /chrissou78/);
  assert.match(html, /<p>hi<\/p>/);
  assert.match(html, /name="viewport"/);
});

test("field renders the right control per type and escapes values", () => {
  assert.match(field({ name: "bio", type: "textarea" }, "a<b"), /<textarea[^>]*name="bio"/);
  assert.match(field({ name: "bio", type: "textarea" }, "a<b"), /a&lt;b/);
  assert.match(field({ name: "n", type: "text", required: true }, ""), /required/);
  assert.match(field({ name: "u", type: "url" }, ""), /type="url"/);
  assert.match(field({ name: "b", type: "checkbox" }, true), /checked/);
  assert.match(field({ name: "p", type: "image" }, "x.jpg"), /type="file"/);
});

test("help text is rendered when present", () => {
  assert.match(field({ name: "x", type: "text", help: "Be brief" }, ""), /Be brief/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-render.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```js
export function escape(text) {
  return String(text ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function layout({ title, user, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} — RegSymp Admin</title>
<link rel="stylesheet" href="/assets/css/admin.css">
</head>
<body>
<header class="a-head">
  <a class="a-brand" href="/admin">RegSymp Admin</a>
  <div class="a-user">${user ? escape(user.login) : ""}
    ${user ? '<a href="/admin/signout">Sign out</a>' : ""}</div>
</header>
<main class="a-main">
${body}
</main>
</body>
</html>`;
}

export function field(def, value) {
  const id = `f-${def.name}`;
  const req = def.required ? " required" : "";
  const help = def.help ? `<span class="a-help">${escape(def.help)}</span>` : "";
  const label = `<label for="${id}">${escape(def.name)}${def.required ? " *" : ""}</label>`;

  let control;
  switch (def.type) {
    case "textarea":
      control = `<textarea id="${id}" name="${escape(def.name)}" rows="5"${req}>${escape(value)}</textarea>`;
      break;
    case "checkbox":
      control = `<input id="${id}" type="checkbox" name="${escape(def.name)}"${value ? " checked" : ""}>`;
      break;
    case "url":
      control = `<input id="${id}" type="url" name="${escape(def.name)}" value="${escape(value)}"${req}>`;
      break;
    case "image":
      control = `<input id="${id}" type="file" name="${escape(def.name)}" accept="image/*">
        <input type="hidden" name="${escape(def.name)}__current" value="${escape(value)}">
        ${value ? `<span class="a-current">current: ${escape(value)}</span>` : ""}`;
      break;
    default:
      control = `<input id="${id}" type="text" name="${escape(def.name)}" value="${escape(value)}"${req}>`;
  }

  return `<div class="a-field">${label}${control}${help}</div>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/admin-render.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add admin/render.js tests/admin-render.test.js
git commit -m "Add admin HTML rendering helpers"
```

---

### Task 6: Routes, guards and mounting

**Files:**
- Create: `admin/routes.js`
- Create: `src/assets/css/admin.css`
- Modify: `server.js`
- Modify: `src/robots.njk`
- Test: `tests/admin-routes.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `createAdmin(config) -> { handle(req, res, url) -> boolean }`. Returns `true` when it handled the request, so `server.js` can fall through to static serving otherwise.

Config: `{ sessions, clientId, clientSecret, allowlist, repo, branch, secret, fetchImpl }`.

- [ ] **Step 1: Write the failing test**

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.js";

let base;
before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const get = (p, init) => fetch(base + p, { redirect: "manual", ...init });

test("every admin route requires a session", async () => {
  const guarded = [
    ["GET", "/admin"],
    ["GET", "/admin/speakers"],
    ["GET", "/admin/speakers/0"],
    ["POST", "/admin/speakers/0"],
    ["POST", "/admin/speakers/new"],
    ["GET", "/admin/partners"],
    ["GET", "/admin/site"]
  ];
  for (const [method, path] of guarded) {
    const res = await get(path, { method });
    assert.ok([302, 401, 403].includes(res.status),
      `${method} ${path} returned ${res.status} without a session`);
  }
});

test("the sign-in page is reachable without a session", async () => {
  const res = await get("/admin/signin");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Sign in with GitHub/);
});

test("the OAuth callback rejects a bad state", async () => {
  const res = await get("/admin/auth/callback?code=x&state=forged");
  assert.ok([400, 403].includes(res.status), `returned ${res.status}`);
});

test("admin is excluded from robots.txt", async () => {
  const res = await fetch(base + "/robots.txt");
  assert.match(await res.text(), /Disallow: \/admin/);
});

test("the site itself is unaffected", async () => {
  assert.equal((await get("/")).status, 200);
  assert.equal((await get("/speakers")).status, 200);
  assert.equal((await get("/api/health")).status, 200);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `/admin` currently 404s, and robots.txt has no Disallow.

- [ ] **Step 3: Implement `admin/routes.js`**

Route table, each entry `{method, pattern, auth, handler}`. The guard runs before
any handler whose `auth` is not `false`, so a route added without thinking is
protected by default.

```js
import { randomBytes } from "node:crypto";
import { getSchema, SCHEMAS, validateRecord } from "./schemas.js";
import { createClient, ConflictError } from "./github.js";
import { authorizeUrl, csrfToken, isAllowed, parseCookies, verifyCsrf } from "./auth.js";
import { escape, field, layout } from "./render.js";

const COOKIE = "regsymp_admin";

export function createAdmin(config) {
  const { sessions, clientId, clientSecret, allowlist, repo, branch, secret,
          fetchImpl = fetch } = config;
  const states = new Map();

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
    res.end(body);
  };
  const redirect = (res, to, headers = {}) => {
    res.writeHead(302, { Location: to, ...headers });
    res.end();
  };

  function sessionFor(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    const s = sessions.get(id);
    return s ? { id, ...s } : null;
  }

  async function readForm(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 12 * 1024 * 1024) throw new Error("Upload too large.");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async function handle(req, res, url) {
    const path = url.pathname;
    if (path !== "/admin" && !path.startsWith("/admin/")) return false;

    // ---- unauthenticated routes -----------------------------------------
    if (path === "/admin/signin") {
      send(res, 200, layout({
        title: "Sign in",
        user: null,
        body: `<div class="a-signin"><h1>RegSymp Admin</h1>
          <p>Content editing is restricted to approved GitHub accounts.</p>
          <a class="a-btn" href="/admin/auth">Sign in with GitHub</a></div>`
      }));
      return true;
    }

    if (path === "/admin/auth") {
      const state = randomBytes(16).toString("hex");
      states.set(state, Date.now() + 10 * 60 * 1000);
      const redirectUri = `${url.protocol}//${url.host}/admin/auth/callback`;
      redirect(res, authorizeUrl({ clientId, redirectUri, state }));
      return true;
    }

    if (path === "/admin/auth/callback") {
      const state = url.searchParams.get("state");
      const expiry = states.get(state);
      states.delete(state);
      if (!expiry || expiry < Date.now()) {
        send(res, 403, layout({ title: "Sign in failed", user: null,
          body: "<p>That sign-in link is invalid or expired. Please try again.</p>" }));
        return true;
      }

      const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code: url.searchParams.get("code")
        })
      });
      const tokenBody = await tokenRes.json().catch(() => ({}));
      const token = tokenBody.access_token;
      if (!token) {
        send(res, 403, layout({ title: "Sign in failed", user: null,
          body: "<p>GitHub did not return a token.</p>" }));
        return true;
      }

      const userRes = await fetchImpl("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "regsymp-admin" }
      });
      const user = await userRes.json().catch(() => ({}));

      if (!isAllowed(user.login, allowlist)) {
        send(res, 403, layout({ title: "Not permitted", user: null,
          body: `<p>${escape(user.login ?? "That account")} is not on the allowlist.</p>` }));
        return true;
      }

      const id = sessions.create({ login: user.login }, token);
      redirect(res, "/admin", {
        "Set-Cookie": `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=28800`
      });
      return true;
    }

    // ---- guard ------------------------------------------------------------
    const session = sessionFor(req);
    if (!session) {
      redirect(res, "/admin/signin");
      return true;
    }

    if (path === "/admin/signout") {
      sessions.destroy(session.id);
      redirect(res, "/admin/signin", {
        "Set-Cookie": `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0`
      });
      return true;
    }

    const gh = createClient({ token: session.token, repo, branch, fetchImpl });
    const token = csrfToken(session.id, secret);

    // ---- index ------------------------------------------------------------
    if (path === "/admin") {
      const rows = Object.entries(SCHEMAS)
        .map(([key, s]) => `<li><a href="/admin/${key}">${escape(s.label)}</a></li>`)
        .join("");
      send(res, 200, layout({
        title: "Collections", user: session.user,
        body: `<h1>Collections</h1><ul class="a-list">${rows}</ul>`
      }));
      return true;
    }

    const parts = path.split("/").filter(Boolean); // ["admin", collection, id?]
    const schema = getSchema(parts[1]);
    if (!schema) {
      send(res, 404, layout({ title: "Not found", user: session.user,
        body: "<p>No such collection.</p>" }));
      return true;
    }

    // The list, form and save handlers follow the same shape for every
    // collection because the schema describes the differences.
    return await handleCollection({
      req, res, url, parts, schema, gh, session, token, send, redirect, readForm
    });
  }

  return { handle };
}
```

The `handleCollection` function is implemented in Task 7; for this task, stub it
to render the list view for `kind: "array"` and return `true`, which is enough to
make the guard tests pass.

- [ ] **Step 4: Mount in `server.js`**

Immediately after the `/api/health` block and before `if (pathname.startsWith("/api/"))`:

```js
  if (admin && (await admin.handle(req, res, url))) return;
```

and near the top:

```js
import { createAdmin } from "./admin/routes.js";
import { createSessions } from "./admin/auth.js";

const admin = process.env.GITHUB_CLIENT_ID
  ? createAdmin({
      sessions: createSessions(),
      clientId: env("GITHUB_CLIENT_ID"),
      clientSecret: env("GITHUB_CLIENT_SECRET"),
      allowlist: env("ADMIN_ALLOWLIST"),
      repo: env("CONTENT_REPO") || "OC-Labs/regsymp",
      branch: env("CONTENT_BRANCH") || "prod",
      secret: env("SESSION_SECRET") || "dev-only-secret"
    })
  : null;
```

When `GITHUB_CLIENT_ID` is unset the admin is disabled entirely and `/admin`
falls through to a 404 — so an unconfigured deploy exposes nothing. The guard
test must therefore set a dummy `GITHUB_CLIENT_ID` before importing the server;
add to the top of `tests/admin-routes.test.js`:

```js
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.ADMIN_ALLOWLIST = "test-user";
process.env.SESSION_SECRET = "test-secret";
```

- [ ] **Step 5: Add `Disallow: /admin` to `src/robots.njk`**

```njk
User-agent: *
Allow: /
Disallow: /admin

Sitemap: {{ site.url }}/sitemap.xml
```

- [ ] **Step 6: Create `src/assets/css/admin.css`**

Use the site's tokens so the admin reads as part of RegSymp: `--navy-deep`
background for the header, `--gold` for primary actions, Inter throughout,
max width 880px, generous field spacing.

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: PASS, including the guard test iterating the route table.

- [ ] **Step 8: Commit**

```bash
git add admin/routes.js src/assets/css/admin.css server.js src/robots.njk tests/admin-routes.test.js
git commit -m "Mount the admin router with authentication guards"
```

---

### Task 7: Collection editing — list, form, save

**Files:**
- Modify: `admin/routes.js`
- Test: `tests/admin-collection.test.js`

**Interfaces:**
- Consumes: `validateRecord`, `gh.getFile`, `gh.putFile`, `verifyCsrf`.
- Produces: `handleCollection({...}) -> Promise<boolean>` handling
  `GET /admin/:collection`, `GET /admin/:collection/:index`,
  `GET /admin/:collection/new`, `POST /admin/:collection/:index`,
  `POST /admin/:collection/:index/delete`, `POST /admin/:collection/:index/move`.

- [ ] **Step 1: Write the failing test**

Tests drive `handleCollection` directly with a stubbed GitHub client rather
than through HTTP, so they stay fast and deterministic.

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdit } from "../admin/routes.js";
import { getSchema } from "../admin/schemas.js";

const speakers = getSchema("speakers");

test("applyEdit updates an existing record in place", () => {
  const data = [{ slug: "a", name: "A", role: "R" }, { slug: "b", name: "B", role: "R" }];
  const out = applyEdit(speakers, data, "0", { name: "A2", role: "R" });
  assert.equal(out.ok, true);
  assert.equal(out.data[0].name, "A2");
  assert.equal(out.data.length, 2);
});

test("applyEdit appends when the index is 'new'", () => {
  const data = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, data, "new", { name: "Barbara Pozdorovkina", role: "CGO" });
  assert.equal(out.data.length, 2);
  assert.equal(out.data[1].slug, "barbara-pozdorovkina");
});

test("applyEdit rejects a duplicate slug", () => {
  const data = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, data, "new", { name: "A", role: "R" });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /unique|already/i.test(e.message)));
});

test("applyEdit surfaces validation errors without mutating the data", () => {
  const data = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, data, "0", { name: "", role: "R" });
  assert.equal(out.ok, false);
  assert.equal(data[0].name, "A");
});

test("applyDelete removes the record at the index", async () => {
  const { applyDelete } = await import("../admin/routes.js");
  const data = [{ slug: "a" }, { slug: "b" }];
  assert.deepEqual(applyDelete(data, "0"), [{ slug: "b" }]);
});

test("applyMove reorders and clamps at the ends", async () => {
  const { applyMove } = await import("../admin/routes.js");
  const data = [{ s: 1 }, { s: 2 }, { s: 3 }];
  assert.deepEqual(applyMove(data, "2", "up").map((r) => r.s), [1, 3, 2]);
  assert.deepEqual(applyMove(data, "0", "up").map((r) => r.s), [1, 2, 3]);
  assert.deepEqual(applyMove(data, "2", "down").map((r) => r.s), [1, 2, 3]);
});

test("serialise writes stable, readable JSON with a trailing newline", async () => {
  const { serialise } = await import("../admin/routes.js");
  const out = serialise([{ b: 1, a: 2 }]);
  assert.ok(out.endsWith("\n"));
  assert.equal(out, JSON.stringify([{ b: 1, a: 2 }], null, 2) + "\n");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-collection.test.js`
Expected: FAIL, `applyEdit` is not exported.

- [ ] **Step 3: Implement the pure helpers and export them**

```js
export function serialise(data) {
  return JSON.stringify(data, null, 2) + "\n";
}

export function applyEdit(schema, data, index, input) {
  const { ok, value, errors } = validateRecord(schema, input);
  if (!ok) return { ok: false, errors, data };

  const unique = schema.fields.filter((f) => f.unique);
  for (const f of unique) {
    const clash = data.some(
      (r, i) => String(i) !== String(index) && r[f.name] === value[f.name]
    );
    if (clash) {
      return {
        ok: false,
        data,
        errors: [{ field: f.name, message: `${f.name} "${value[f.name]}" is already used.` }]
      };
    }
  }

  const next = data.slice();
  if (index === "new") next.push(value);
  else next[Number(index)] = { ...next[Number(index)], ...value };
  return { ok: true, data: next, errors: [] };
}

export function applyDelete(data, index) {
  const next = data.slice();
  next.splice(Number(index), 1);
  return next;
}

export function applyMove(data, index, direction) {
  const i = Number(index);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || i >= data.length || j < 0 || j >= data.length) return data.slice();
  const next = data.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
```

Then wire `handleCollection` to: load the file via `gh.getFile`, parse it, render
the list or form, and on POST verify CSRF, apply the helper, `serialise`, and
`gh.putFile` with the loaded `sha`. On `ConflictError`, re-render the form with
a message saying someone else saved first and the edit was not applied.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/routes.js tests/admin-collection.test.js
git commit -m "Add admin collection list, edit, delete and reorder"
```

---

### Task 8: Image upload

**Files:**
- Modify: `admin/routes.js`
- Create: `admin/multipart.js`
- Test: `tests/admin-multipart.test.js`

**Interfaces:**
- Consumes: `slugifyFilename` from `admin/sanitise.js`, `gh.putFile`.
- Produces: `parseMultipart(buffer, boundary) -> {fields: {}, files: [{name, filename, type, data}]}`;
  `detectImageType(buffer) -> "jpg"|"png"|"webp"|"svg"|null`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMultipart, detectImageType } from "../admin/multipart.js";

function body(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="${p.name}"` +
      (p.filename ? `; filename="${p.filename}"` : "") + "\r\n" +
      (p.type ? `Content-Type: ${p.type}\r\n` : "") + "\r\n"
    ));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(String(p.data)));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test("parses fields and files", () => {
  const b = "X";
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const parsed = parseMultipart(body(b, [
    { name: "name", data: "Rony Vogel" },
    { name: "photo", filename: "Rony Vogel.png", type: "image/png", data: png }
  ]), b);

  assert.equal(parsed.fields.name, "Rony Vogel");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].filename, "Rony Vogel.png");
  assert.ok(parsed.files[0].data.equals(png));
});

test("an empty file input yields no file", () => {
  const b = "X";
  const parsed = parseMultipart(body(b, [
    { name: "photo", filename: "", type: "application/octet-stream", data: "" }
  ]), b);
  assert.equal(parsed.files.length, 0);
});

test("detectImageType sniffs magic bytes, not the declared type", () => {
  assert.equal(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpg");
  assert.equal(
    detectImageType(Buffer.concat([
      Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")
    ])), "webp");
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), "svg");
  assert.equal(detectImageType(Buffer.from("MZ\x90\x00 not an image")), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/admin-multipart.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `admin/multipart.js`**

```js
export function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = [];
  const delim = Buffer.from(`--${boundary}`);
  let start = buffer.indexOf(delim);
  if (start === -1) return { fields, files };

  while (start !== -1) {
    const bodyStart = start + delim.length;
    if (buffer.slice(bodyStart, bodyStart + 2).toString() === "--") break;

    const headerEnd = buffer.indexOf("\r\n\r\n", bodyStart);
    if (headerEnd === -1) break;
    const headers = buffer.slice(bodyStart, headerEnd).toString("utf8");

    const next = buffer.indexOf(delim, headerEnd);
    const contentEnd = next === -1 ? buffer.length : next - 2; // trailing CRLF
    const data = buffer.slice(headerEnd + 4, contentEnd);

    const nameMatch = headers.match(/name="([^"]*)"/);
    const fileMatch = headers.match(/filename="([^"]*)"/);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      if (fileMatch) {
        if (fileMatch[1] && data.length > 0) {
          files.push({
            name: nameMatch[1],
            filename: fileMatch[1],
            type: typeMatch ? typeMatch[1].trim() : "",
            data
          });
        }
      } else {
        fields[nameMatch[1]] = data.toString("utf8");
      }
    }
    start = next;
  }
  return { fields, files };
}

export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.slice(0, 4).toString() === "RIFF" && buffer.slice(8, 12).toString() === "WEBP") return "webp";
  const head = buffer.slice(0, 200).toString("utf8").trim();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}
```

- [ ] **Step 4: Wire upload into the save handler**

On POST with a file part: sniff the type, reject anything `detectImageType`
returns `null` for, cap at 8 MB, `slugifyFilename` the name and force the
extension to the sniffed type, then `gh.putFile` the binary into the field's
`dir` before committing the JSON. If the target name exists, append `-2`, `-3`.
Store the resulting basename in the record's field.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin/multipart.js admin/routes.js tests/admin-multipart.test.js
git commit -m "Add image upload with filename slugification and type sniffing"
```

---

### Task 9: Documentation and rollout

**Files:**
- Modify: `DEPLOY.md`
- Modify: `.env.example`

- [ ] **Step 1: Document the new environment variables in `.env.example`**

```
# Admin interface. Leave GITHUB_CLIENT_ID unset to disable /admin entirely.
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
ADMIN_ALLOWLIST=chrissou78
CONTENT_REPO=OC-Labs/regsymp
CONTENT_BRANCH=prod
SESSION_SECRET=
```

- [ ] **Step 2: Add an admin section to `DEPLOY.md`**

Cover: registering the GitHub OAuth app with callback
`https://regsymp.com/admin/auth/callback`, the allowlist, and the rule that
`prod` must never be force-pushed now that content lives there.

- [ ] **Step 3: Run the full suite and commit**

```bash
npm test
git add DEPLOY.md .env.example
git commit -m "Document admin configuration and the prod branch rule"
```

---

## Notes for the implementer

**The admin is disabled unless `GITHUB_CLIENT_ID` is set.** An unconfigured
deploy exposes nothing, which means this can be merged and deployed before the
OAuth app exists.

**Guards are default-deny.** The unauthenticated routes are listed explicitly
and everything after the guard is protected. A new route added below the guard
is protected automatically; one added above it is not, which is what the
route-table test is for.

**Never log tokens.** Not the OAuth token, not the session id.

**`prod` is never force-pushed again.** Content now lives on that branch and a
force-push would destroy it.
