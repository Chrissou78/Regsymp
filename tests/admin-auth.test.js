import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessions,
  csrfToken,
  verifyCsrf,
  isAllowed,
  authorizeUrl,
  parseCookies
} from "../admin/auth.js";

test("sessions round-trip and can be destroyed", () => {
  const sessions = createSessions();
  const id = sessions.create({ login: "chrissou78" }, "gh_token");

  assert.match(id, /^[a-f0-9]{32,}$/);
  assert.equal(sessions.get(id).user.login, "chrissou78");
  assert.equal(sessions.get(id).token, "gh_token");

  sessions.destroy(id);
  assert.equal(sessions.get(id), undefined);
});

test("expired sessions are not returned", () => {
  const sessions = createSessions({ ttlMs: -1 });
  const id = sessions.create({ login: "x" }, "t");
  assert.equal(sessions.get(id), undefined);
  assert.equal(sessions.size(), 0, "expired sessions are swept, not retained");
});

test("an unknown or empty session id yields nothing", () => {
  const sessions = createSessions();
  assert.equal(sessions.get("nope"), undefined);
  assert.equal(sessions.get(""), undefined);
  assert.equal(sessions.get(undefined), undefined);
});

test("session ids are unpredictable and distinct", () => {
  const sessions = createSessions();
  const ids = new Set(Array.from({ length: 200 }, () => sessions.create({ login: "x" }, "t")));
  assert.equal(ids.size, 200, "session ids must never collide");
});

test("the allowlist is exact and case-insensitive", () => {
  assert.equal(isAllowed("chrissou78", "chrissou78,other"), true);
  assert.equal(isAllowed("CHRISSOU78", "chrissou78"), true);
  assert.equal(isAllowed("chrissou78", " chrissou78 , other "), true);
  assert.equal(isAllowed("chrissou7", "chrissou78"), false, "no prefix matching");
  assert.equal(isAllowed("chrissou789", "chrissou78"), false, "no suffix matching");
  assert.equal(isAllowed("evil", "chrissou78"), false);
});

test("an empty allowlist permits nobody", () => {
  assert.equal(isAllowed("anyone", ""), false);
  assert.equal(isAllowed("anyone", undefined), false);
  assert.equal(isAllowed("anyone", "  ,  "), false);
  assert.equal(isAllowed("", ""), false);
});

test("csrf tokens are bound to the session and the secret", () => {
  const token = csrfToken("session-a", "secret");
  assert.equal(verifyCsrf("session-a", token, "secret"), true);
  assert.equal(verifyCsrf("session-b", token, "secret"), false);
  assert.equal(verifyCsrf("session-a", token, "other-secret"), false);
  assert.equal(verifyCsrf("session-a", "garbage", "secret"), false);
  assert.equal(verifyCsrf("session-a", "", "secret"), false);
  assert.equal(verifyCsrf("session-a", undefined, "secret"), false);
});

test("authorizeUrl carries client id, redirect and state", () => {
  const url = new URL(
    authorizeUrl({
      clientId: "cid",
      redirectUri: "https://regsymp.com/admin/auth/callback",
      state: "st"
    })
  );
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("redirect_uri"), "https://regsymp.com/admin/auth/callback");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("scope"), "repo");
});

test("parseCookies handles multiple values and junk", () => {
  assert.deepEqual(parseCookies("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookies("a=1"), { a: "1" });
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("novalue; a=1"), { a: "1" });
});

test("changing a password can end that account's other sessions", () => {
  const sessions = createSessions();
  const mine = sessions.create({ email: "me@example.com" }, "t");
  const otherDevice = sessions.create({ email: "me@example.com" }, "t");
  const someoneElse = sessions.create({ email: "other@example.com" }, "t");

  const ended = sessions.destroyOthersFor("me@example.com", mine);

  assert.equal(ended, 1);
  assert.ok(sessions.get(mine), "the current session survives");
  assert.equal(sessions.get(otherDevice), undefined, "the other device is signed out");
  assert.ok(sessions.get(someoneElse), "other accounts are untouched");
});
