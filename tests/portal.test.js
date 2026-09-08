import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createDb, migrate } from "../admin/db.js";
import { createAttendees } from "../admin/attendees.js";
import { createPortal } from "../portal/routes.js";
import { createSessions } from "../admin/auth.js";

/**
 * The attendee portal, driven over HTTP against a real database.
 *
 * A real Postgres because the interesting parts are the schema's: the ticket
 * numbering constraint, the token expiry, the uniqueness of an email.
 */
const URL = process.env.TEST_DATABASE_URL;
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)[:/]/;
const unsafe = URL && !LOCAL.test(URL) && process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== "1";

const opts = !URL
  ? { skip: "set TEST_DATABASE_URL to run the portal tests" }
  : unsafe
    ? { skip: "REFUSED: TEST_DATABASE_URL is not local and these tests truncate tables." }
    : {};

let db;
let attendees;
let server;
let base;

before(async () => {
  if (!URL || unsafe) return;
  db = createDb({ url: URL });
  await migrate(db);
  attendees = createAttendees({ db });

  const portal = createPortal({
    attendees,
    sessions: createSessions(),
    secret: () => "portal-test-secret",
    // No mail in tests: record what would have been sent instead.
    mail: {
      configured: () => true,
      sendResetLink: async (m) => sent.push({ kind: "reset", ...m }),
      sendVerificationLink: async (m) => sent.push({ kind: "verify", ...m })
    }
  });

  const { createServer } = await import("node:http");
  server = createServer(async (req, res) => {
    const url = new globalThis.URL(req.url, "http://localhost");
    if (await portal.handle(req, res, url)) return;
    res.writeHead(404).end("not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (db) await db.end();
});

const sent = [];

async function reset() {
  await db.query("truncate attendees cascade");
  sent.length = 0;
}

const get = (p, init) => fetch(base + p, { redirect: "manual", ...init });

const post = (p, fields, cookie) =>
  fetch(base + p, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {})
    },
    body: new URLSearchParams(fields).toString()
  });

const cookieFrom = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

/** An attendee with a ticket and a claimed password. */
async function claimedGuest({ category = "vip", password = "a-long-enough-password" } = {}) {
  const guest = await attendees.create(
    { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace", company: "Engines" },
    "chris@onchainlabs.ch"
  );
  await attendees.issueTicket({ attendeeId: guest.id, category, issuedBy: "chris", areas: ["main"] });
  const token = await attendees.createToken(guest.id, "claim");
  await attendees.redeemToken(token, "claim", password);
  const res = await post("/portal/signin", { email: guest.email, password });
  return { guest, cookie: cookieFrom(res), password };
}

// ------------------------------------------------------------------- access

test("the portal is closed without a session", opts, async () => {
  await reset();
  for (const path of ["/portal", "/portal/ticket", "/portal/password"]) {
    const res = await get(path);
    assert.equal(res.status, 302, `${path} was reachable`);
    assert.equal(res.headers.get("location"), "/portal/signin");
  }
});

test("the sign-in page is reachable, and asks not to be indexed", opts, async () => {
  await reset();
  const res = await get("/portal/signin");
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /noindex/);
  assert.match(body, /Attendance is by invitation/);
});

// ------------------------------------------------------------------ claiming

test("a claim link sets the password and signs the guest in", opts, async () => {
  await reset();
  const guest = await attendees.create({ email: "ada@example.com" }, "chris@onchainlabs.ch");
  const token = await attendees.createToken(guest.id, "claim");

  const page = await (await get(`/portal/claim/${token}`)).text();
  assert.match(page, /ada@example\.com/, "the page does not say whose account it is");

  const res = await post(`/portal/claim/${token}`, {
    password: "a-long-enough-password",
    confirm: "a-long-enough-password"
  });
  assert.equal(res.status, 302);
  assert.match(cookieFrom(res), /^regsymp_guest=/);
  assert.equal((await attendees.byId(guest.id)).claimed, true);
});

test("a claim link works once", opts, async () => {
  await reset();
  const guest = await attendees.create({ email: "ada@example.com" }, "chris");
  const token = await attendees.createToken(guest.id, "claim");
  await post(`/portal/claim/${token}`, { password: "a-long-enough-password", confirm: "a-long-enough-password" });

  const again = await get(`/portal/claim/${token}`);
  assert.equal(again.status, 400);
  assert.match(await again.text(), /invalid, already used, or expired/);
});

test("an unknown claim link reveals nothing", opts, async () => {
  await reset();
  const res = await get("/portal/claim/not-a-real-token-at-all");
  assert.equal(res.status, 400);
  const body = await res.text();
  // An email shape, not a bare "@": the stylesheet URL contains wght@400.
  assert.doesNotMatch(body, /[\w.+-]+@[\w-]+\.\w{2,}/, "the page mentioned an address");
});

test("mismatched passwords are refused before anything is saved", opts, async () => {
  await reset();
  const guest = await attendees.create({ email: "ada@example.com" }, "chris");
  const token = await attendees.createToken(guest.id, "claim");

  const res = await post(`/portal/claim/${token}`, { password: "a-long-enough-password", confirm: "different" });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /do not match/);
  assert.equal((await attendees.byId(guest.id)).claimed, false);
});

// -------------------------------------------------------------------- signin

test("a wrong password and an unknown guest look identical", opts, async () => {
  // Otherwise the form is a guest-list lookup for anybody who asks.
  await reset();
  const { password } = await claimedGuest();

  const wrong = await post("/portal/signin", { email: "ada@example.com", password: "nope" });
  const unknown = await post("/portal/signin", { email: "nobody@example.com", password });

  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  const [a, b] = [await wrong.text(), await unknown.text()];
  assert.match(a, /do not match an account/);
  assert.equal(a.replace(/value="[^"]*"/g, ""), b.replace(/value="[^"]*"/g, ""));
});

test("a forgotten-password request never says whether the address exists", opts, async () => {
  await reset();
  await claimedGuest();

  const known = await post("/portal/forgot", { email: "ada@example.com" });
  const unknown = await post("/portal/forgot", { email: "nobody@example.com" });

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.equal(await known.text(), await unknown.text());
  assert.equal(sent.length, 1, "a reset link was sent for an address with no account");
  assert.equal(sent[0].to, "ada@example.com");
});

// ------------------------------------------------------------------- profile

test("the profile shows the guest and their ticket", opts, async () => {
  await reset();
  const { cookie } = await claimedGuest({ category: "vip" });

  const body = await (await get("/portal", { headers: { cookie } })).text();
  assert.match(body, /ada@example\.com/);
  assert.match(body, /Ada/);
  assert.match(body, /1\/33/, "the ticket number is not shown");
  assert.match(body, /VIP badge/);
});

test("a guest can edit their own details", opts, async () => {
  await reset();
  const { guest, cookie } = await claimedGuest();
  const page = await (await get("/portal", { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  const res = await post(
    "/portal",
    { csrf, firstName: "Ada", lastName: "Byron", company: "Engines Ltd", linkedin: "https://example.com/ada" },
    cookie
  );
  assert.equal(res.status, 200);

  const after = await attendees.byId(guest.id);
  assert.equal(after.lastName, "Byron");
  assert.equal(after.company, "Engines Ltd");
  assert.equal(after.socials.linkedin, "https://example.com/ada");
});

test("a guest cannot promote themselves or change their address", opts, async () => {
  // The form does not offer these; the handler must refuse them anyway.
  await reset();
  const { guest, cookie } = await claimedGuest();
  const page = await (await get("/portal", { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  await post("/portal", { csrf, role: "speaker", email: "hacker@example.com", firstName: "Ada" }, cookie);

  const after = await attendees.byId(guest.id);
  assert.equal(after.role, "visitor", "the guest promoted themselves");
  assert.equal(after.email, "ada@example.com", "the guest changed their address");
});

test("a write without a CSRF token is refused", opts, async () => {
  await reset();
  const { guest, cookie } = await claimedGuest();
  const res = await post("/portal", { firstName: "Hacker" }, cookie);

  assert.equal(res.status, 403);
  assert.notEqual((await attendees.byId(guest.id)).firstName, "Hacker");
});

test("consent is recorded, and cleared when unticked", opts, async () => {
  // Bulk mail to a stored list needs a lawful basis and a record of it.
  await reset();
  const { guest, cookie } = await claimedGuest();
  const page = await (await get("/portal", { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  await post("/portal", { csrf, consentMarketing: "yes" }, cookie);
  let after = await attendees.byId(guest.id);
  assert.equal(after.consentMarketing, true);
  assert.ok(after.consentAt, "no timestamp was recorded");

  await post("/portal", { csrf }, cookie);
  after = await attendees.byId(guest.id);
  assert.equal(after.consentMarketing, false);
});

// -------------------------------------------------------------------- ticket

test("the ticket page carries a QR code and the number", opts, async () => {
  await reset();
  const { cookie } = await claimedGuest({ category: "visitor" });

  const body = await (await get("/portal/ticket", { headers: { cookie } })).text();
  assert.match(body, /<svg/, "no QR code");
  assert.match(body, /34\/100/, "wrong number or label");
  assert.match(body, /Ada Lovelace/);
});

test("a guest with no ticket is sent back rather than shown an empty one", opts, async () => {
  await reset();
  const guest = await attendees.create({ email: "ada@example.com" }, "chris");
  const token = await attendees.createToken(guest.id, "claim");
  const res = await post(`/portal/claim/${token}`, {
    password: "a-long-enough-password",
    confirm: "a-long-enough-password"
  });
  const cookie = cookieFrom(res);

  const ticket = await get("/portal/ticket", { headers: { cookie } });
  assert.equal(ticket.status, 302);
  assert.equal(ticket.headers.get("location"), "/portal");

  const profile = await (await get("/portal", { headers: { cookie } })).text();
  assert.match(profile, /No ticket has been issued/);
});

// ------------------------------------------------------------------ check-in

test("scanning a valid code identifies the holder", opts, async () => {
  await reset();
  const { guest } = await claimedGuest({ category: "vip" });
  const ticket = await attendees.ticketFor(guest.id);

  const res = await get(`/t/${ticket.code}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Valid ticket|Ada Lovelace/);
  assert.match(body, /1\/33/);
});

test("an invalid code reveals nothing at all", opts, async () => {
  await reset();
  await claimedGuest();

  for (const code of ["", "short", "a".repeat(32), "../../etc/passwd"]) {
    const res = await get(`/t/${encodeURIComponent(code)}`);
    assert.ok([404, 200].includes(res.status));
    if (res.status === 200) {
      const body = await res.text();
      assert.doesNotMatch(body, /Ada/, `${code} leaked a name`);
    }
  }
});

// -------------------------------------------------------------------- signout

test("signing out ends the session", opts, async () => {
  await reset();
  const { cookie } = await claimedGuest();
  const page = await (await get("/portal", { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  const res = await post("/portal/signout", { csrf }, cookie);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const after = await get("/portal", { headers: { cookie } });
  assert.equal(after.status, 302);
  assert.equal(after.headers.get("location"), "/portal/signin");
});

test("the session cookie carries nothing but an opaque id", opts, async () => {
  await reset();
  const { cookie } = await claimedGuest();
  assert.doesNotMatch(cookie, /ada|example|@/i, "the cookie carries identifying data");
  assert.match(cookie, /^regsymp_guest=[a-f0-9]{32,}$/);
});

// --------------------------------------------------------------- registration

test("anyone may create an account, and is signed in straight away", opts, async () => {
  // An account is identity, not admission: it grants nothing on its own.
  await reset();
  const res = await post("/portal/register", {
    firstName: "Grace",
    lastName: "Hopper",
    company: "Navy",
    email: "grace@example.com",
    password: "a-long-enough-password"
  });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /Confirm your email/);
  assert.match(cookieFrom(res), /^regsymp_guest=/);

  const guest = await attendees.byEmail("grace@example.com");
  assert.equal(guest.selfRegistered, true);
  assert.equal(guest.claimed, true);
  assert.equal(guest.emailVerified, false, "a fresh registration must not be verified");
  assert.equal(sent.filter((m) => m.kind === "verify").length, 1);
});

test("an account alone carries no ticket", opts, async () => {
  await reset();
  const res = await post("/portal/register", {
    email: "grace@example.com",
    password: "a-long-enough-password"
  });
  const cookie = cookieFrom(res);

  const guest = await attendees.byEmail("grace@example.com");
  assert.equal(await attendees.ticketFor(guest.id), null);

  const profile = await (await get("/portal", { headers: { cookie } })).text();
  assert.match(profile, /No ticket has been issued/);
});

test("registering an address that already exists reveals nothing", opts, async () => {
  // Otherwise the form is a membership oracle. The owner gets a reset link
  // instead, so a genuine returning guest is not stuck.
  await reset();
  await claimedGuest();
  sent.length = 0;

  const res = await post("/portal/register", {
    email: "ada@example.com",
    password: "a-different-long-password"
  });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /Confirm your email/, "the wording differed for a taken address");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "reset", "the existing account was not offered a way in");

  // And the original password must still work.
  assert.equal(await attendees.verify("ada@example.com", "a-long-enough-password"), true);
  assert.equal(await attendees.verify("ada@example.com", "a-different-long-password"), false);
});

test("a filled honeypot is accepted and ignored", opts, async () => {
  // Answering differently would tell a bot exactly what tripped it.
  await reset();
  const res = await post("/portal/register", {
    email: "bot@example.com",
    password: "a-long-enough-password",
    website: "http://spam.example"
  });

  assert.equal(res.status, 200);
  assert.match(await res.text(), /Confirm your email/);
  assert.equal(await attendees.byEmail("bot@example.com"), null, "the bot got an account");
});

test("a verification link confirms the address, once", opts, async () => {
  await reset();
  await post("/portal/register", { email: "grace@example.com", password: "a-long-enough-password" });
  const guest = await attendees.byEmail("grace@example.com");
  const url = sent.find((m) => m.kind === "verify").url;
  const token = url.split("/").pop();

  const res = await get(`/portal/verify/${token}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /confirmed/i);
  assert.equal((await attendees.byId(guest.id)).emailVerified, true);

  const again = await get(`/portal/verify/${token}`);
  assert.equal(again.status, 400);
});

test("a ticket cannot be issued to an unconfirmed self-registration", opts, async () => {
  // The rule lives in the store, so the admin screen cannot bypass it.
  await reset();
  await post("/portal/register", { email: "grace@example.com", password: "a-long-enough-password" });
  const guest = await attendees.byEmail("grace@example.com");

  await assert.rejects(
    () => attendees.issueTicket({ attendeeId: guest.id, category: "vip", issuedBy: "chris" }),
    /has not confirmed their email/
  );

  const url = sent.find((m) => m.kind === "verify").url;
  await attendees.verifyEmail(url.split("/").pop());
  const ticket = await attendees.issueTicket({ attendeeId: guest.id, category: "vip", issuedBy: "chris" });
  assert.equal(ticket.number, 1);
});

test("an address an admin entered needs no click", opts, async () => {
  // A person vouched for it, which is a better signal than a click.
  await reset();
  const guest = await attendees.create({ email: "invited@example.com" }, "chris@onchainlabs.ch");
  assert.equal(guest.selfRegistered, false);

  const ticket = await attendees.issueTicket({ attendeeId: guest.id, category: "vip", issuedBy: "chris" });
  assert.equal(ticket.number, 1);
});

test("an unverified guest is told, and can ask again", opts, async () => {
  await reset();
  const res = await post("/portal/register", {
    email: "grace@example.com",
    password: "a-long-enough-password"
  });
  const cookie = cookieFrom(res);

  const profile = await (await get("/portal", { headers: { cookie } })).text();
  assert.match(profile, /has not been confirmed/);
  const csrf = profile.match(/name="csrf" value="([a-f0-9]+)"/)[1];

  sent.length = 0;
  const resend = await post("/portal/resend", { csrf }, cookie);
  assert.equal(resend.status, 200);
  assert.equal(sent.filter((m) => m.kind === "verify").length, 1);
});

test("a verified guest is not nagged", opts, async () => {
  await reset();
  const { cookie } = await claimedGuest();
  const profile = await (await get("/portal", { headers: { cookie } })).text();
  assert.doesNotMatch(profile, /has not been confirmed/);
});
