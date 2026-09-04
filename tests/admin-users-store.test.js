import { test } from "node:test";
import assert from "node:assert/strict";
import { createUserStore, hashToken } from "../admin/users-store.js";
import { hashPassword } from "../admin/password.js";

/** An in-memory stand-in for the GitHub Contents API. */
function fakeGh(initial = null) {
  const state = { content: initial === null ? null : JSON.stringify(initial), sha: "sha-0", writes: [] };
  return {
    state,
    async getFile() {
      if (state.content === null) return null;
      return { content: state.content, sha: state.sha };
    },
    async putFile({ content, message }) {
      state.content = content;
      state.sha = `sha-${state.writes.length + 1}`;
      state.writes.push(message);
      return { commit: { sha: "abc1234", htmlUrl: "https://github.com/x" } };
    }
  };
}

const store = (gh, extra = {}) => createUserStore({ gh, ...extra });

test("an invite can be created and redeemed into an account", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);

  const token = await s.createInvite("New.Person@Example.com", "boss@example.com");
  assert.match(token, /^[a-f0-9]{64}$/);

  const invite = await s.findInvite(token);
  assert.equal(invite.email, "new.person@example.com", "emails are lowercased");

  const email = await s.redeemInvite(token, "a-long-enough-password");
  assert.equal(email, "new.person@example.com");

  assert.equal(await s.verify("new.person@example.com", "a-long-enough-password"), true);
  assert.equal(await s.verify("new.person@example.com", "wrong"), false);
});

test("the raw invite token is never stored", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("x@example.com", "boss@example.com");

  assert.ok(!gh.state.content.includes(token), "the token itself must not be written");
  assert.ok(gh.state.content.includes(hashToken(token)), "only its digest is stored");
});

test("a redeemed invite cannot be reused", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("x@example.com", "boss@example.com");
  await s.redeemInvite(token, "a-long-enough-password");

  await assert.rejects(() => s.redeemInvite(token, "another-password-x"), /invalid or has expired/);
  assert.equal(await s.findInvite(token), null);
});

test("an expired invite is not accepted", async () => {
  let clock = 1_000_000;
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh, { now: () => clock });
  const token = await s.createInvite("x@example.com", "boss@example.com");

  clock += 8 * 24 * 60 * 60 * 1000; // past the 7-day window
  assert.equal(await s.findInvite(token), null);
  await assert.rejects(() => s.redeemInvite(token, "a-long-enough-password"), /invalid or has expired/);
});

test("a forged or empty token is rejected", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  await s.createInvite("x@example.com", "boss@example.com");

  for (const bad of ["", null, undefined, "0".repeat(64), "not-hex", "abc"]) {
    assert.equal(await s.findInvite(bad), null, `token ${JSON.stringify(bad)}`);
  }
});

test("short passwords are refused", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("x@example.com", "boss@example.com");
  await assert.rejects(() => s.redeemInvite(token, "short"), /at least 12/);
});

test("inviting an existing account is refused", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("x@example.com", "boss@example.com");
  await s.redeemInvite(token, "a-long-enough-password");

  await assert.rejects(() => s.createInvite("x@example.com", "boss@example.com"), /already has an account/);
});

test("an environment account still works as a fallback", async () => {
  const hash = await hashPassword("env-password-1234");
  const gh = fakeGh(null); // no users.json in the repo at all
  const s = store(gh, { fallbackUsers: `recovery@example.com:${hash}` });

  assert.equal(await s.verify("recovery@example.com", "env-password-1234"), true);
  assert.equal(await s.verify("recovery@example.com", "wrong"), false);
});

test("an unknown account never verifies", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  assert.equal(await s.verify("nobody@example.com", "anything"), false);
  assert.equal(await s.verify("", ""), false);
});

test("the last remaining admin cannot be removed", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("only@example.com", "boss@example.com");
  await s.redeemInvite(token, "a-long-enough-password");

  await assert.rejects(() => s.removeUser("only@example.com", "only@example.com"), /only remaining admin/);
});

test("an admin can be removed once another exists", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  for (const email of ["one@example.com", "two@example.com"]) {
    const t = await s.createInvite(email, "boss@example.com");
    await s.redeemInvite(t, "a-long-enough-password");
  }

  await s.removeUser("one@example.com", "two@example.com");
  const users = await s.listUsers();
  assert.deepEqual(users.map((u) => u.email), ["two@example.com"]);
  assert.equal(await s.verify("one@example.com", "a-long-enough-password"), false);
});

test("a corrupt users file fails closed rather than open", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  gh.state.content = "{ not json";
  const s = store(gh);
  assert.equal(await s.verify("anyone@example.com", "anything"), false);
  assert.deepEqual(await s.listUsers(), []);
});

test("writes carry a descriptive commit message", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("x@example.com", "boss@example.com");
  await s.redeemInvite(token, "a-long-enough-password");

  assert.match(gh.state.writes[0], /Invite x@example\.com/);
  assert.match(gh.state.writes[1], /Add admin x@example\.com/);
});

// ------------------------------------------------- direct account creation

test("an account can be created directly with a temporary password", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);

  const email = await s.createUser("New.Admin@Example.com", "temporary-pass-1", "boss@example.com");
  assert.equal(email, "new.admin@example.com", "emails are lowercased");
  assert.equal(await s.verify("new.admin@example.com", "temporary-pass-1"), true);
  assert.equal(await s.verify("new.admin@example.com", "wrong"), false);

  const [user] = await s.listUsers();
  assert.equal(user.mustChangePassword, true, "flagged as a temporary credential");
});

test("creating an account clears any outstanding invitation for that address", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  const token = await s.createInvite("dup@example.com", "boss@example.com");
  await s.createUser("dup@example.com", "temporary-pass-1", "boss@example.com");

  assert.equal(await s.findInvite(token), null, "the stale invite must not survive");
  assert.equal((await s.listInvites()).length, 0);
});

test("direct creation refuses duplicates and weak passwords", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  await s.createUser("one@example.com", "temporary-pass-1", "boss@example.com");

  await assert.rejects(
    () => s.createUser("one@example.com", "another-pass-12", "boss@example.com"),
    /already has an account/
  );
  await assert.rejects(() => s.createUser("two@example.com", "short", "boss@example.com"), /at least 12/);
  await assert.rejects(() => s.createUser("notanemail", "temporary-pass-1", "boss@example.com"), /email address/);
});

// ----------------------------------------------------------- password change

test("a password can be changed with the current one", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  await s.createUser("me@example.com", "original-pass-1", "boss@example.com");

  await s.changePassword("me@example.com", "original-pass-1", "replacement-pass-2");

  assert.equal(await s.verify("me@example.com", "replacement-pass-2"), true);
  assert.equal(await s.verify("me@example.com", "original-pass-1"), false, "the old one must stop working");

  const [user] = await s.listUsers();
  assert.equal(user.mustChangePassword, false, "the temporary flag is cleared");
  assert.ok(user.passwordChangedAt);
});

test("changing a password requires the correct current one", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  await s.createUser("me@example.com", "original-pass-1", "boss@example.com");

  await assert.rejects(
    () => s.changePassword("me@example.com", "not-the-password", "replacement-pass-2"),
    /current password is not correct/
  );
  assert.equal(await s.verify("me@example.com", "original-pass-1"), true, "unchanged after a failed attempt");
});

test("a new password must be long enough and actually new", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  await s.createUser("me@example.com", "original-pass-1", "boss@example.com");

  await assert.rejects(() => s.changePassword("me@example.com", "original-pass-1", "short"), /at least 12/);
  await assert.rejects(
    () => s.changePassword("me@example.com", "original-pass-1", "original-pass-1"),
    /same as your current/
  );
});

test("an environment-configured account cannot be changed from the interface", async () => {
  const { hashPassword } = await import("../admin/password.js");
  const hash = await hashPassword("env-password-1234");
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh, { fallbackUsers: `env@example.com:${hash}` });

  await assert.rejects(
    () => s.changePassword("env@example.com", "env-password-1234", "replacement-pass-2"),
    /configured on the server/
  );
});

// ------------------------------------------------------------------ owner

test("the first account is the owner", async () => {
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  await s.createUser("first@example.com", "temporary-pass-1", "bootstrap");
  await s.createUser("second@example.com", "temporary-pass-2", "first@example.com");

  assert.equal(await s.isOwner("first@example.com"), true);
  assert.equal(await s.isOwner("FIRST@EXAMPLE.COM"), true, "case-insensitive");
  assert.equal(await s.isOwner("second@example.com"), false);
  assert.equal(await s.ownerEmail(), "first@example.com");
});

test("an explicit owner flag wins over creation order", async () => {
  const gh = fakeGh({
    users: [
      { email: "first@example.com", hash: "scrypt$00$00" },
      { email: "boss@example.com", hash: "scrypt$00$00", owner: true }
    ],
    invites: []
  });
  const s = store(gh);
  assert.equal(await s.isOwner("boss@example.com"), true);
  assert.equal(await s.isOwner("first@example.com"), false);
});

test("with no stored accounts the environment account may recover", async () => {
  // Signing in at all then requires ADMIN_USERS, and that account has to be
  // able to repair a damaged or empty users file.
  const gh = fakeGh({ users: [], invites: [] });
  const s = store(gh);
  assert.equal(await s.isOwner("recovery@example.com"), true);
  assert.equal(await s.isOwner(""), false, "still needs an identity");
  assert.equal(await s.ownerEmail(), null);
});
