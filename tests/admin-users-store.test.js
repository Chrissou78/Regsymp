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
