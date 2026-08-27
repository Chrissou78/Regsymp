import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, ConflictError } from "../admin/github.js";

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return routes[key](url, init);
  };
  return { fetchImpl, calls };
}

test("getFile decodes base64 content and returns the sha", async () => {
  const { fetchImpl, calls } = stub({
    "src/_data/speakers.json": async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: Buffer.from('[{"a":1}]').toString("base64"),
        sha: "abc123"
      })
    })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  const file = await gh.getFile("src/_data/speakers.json");

  assert.equal(file.content, '[{"a":1}]');
  assert.equal(file.sha, "abc123");
  assert.ok(calls[0].url.includes("ref=prod"), "must read from the configured branch");
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
  assert.equal(res.commit.htmlUrl, "https://github.com/x");

  const call = calls.at(-1);
  assert.ok(call.url.includes("/repos/OC-Labs/regsymp/contents/src/_data/faq.json"));
  assert.equal(call.init.method, "PUT");
  const body = JSON.parse(call.init.body);
  assert.equal(body.branch, "prod");
  assert.equal(body.sha, "old");
  assert.equal(body.message, "update faq");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), '[{"q":1}]');
});

test("putFile omits sha when creating a new file", async () => {
  const { fetchImpl, calls } = stub({
    "contents/": async () => ({ ok: true, status: 201, json: async () => ({ commit: {} }) })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  await gh.putFile({ path: "new.json", content: "{}", message: "create" });
  assert.ok(!("sha" in JSON.parse(calls.at(-1).init.body)));
});

test("binary content is base64 encoded from the buffer", async () => {
  const { fetchImpl, calls } = stub({
    "contents/": async () => ({ ok: true, status: 201, json: async () => ({ commit: {} }) })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await gh.putFile({ path: "a.png", content: png, message: "m", isBinary: true });

  const sent = Buffer.from(JSON.parse(calls.at(-1).init.body).content, "base64");
  assert.ok(sent.equals(png), "binary must survive the round trip byte for byte");
});

test("a sha mismatch raises ConflictError rather than reporting success", async () => {
  for (const status of [409, 422]) {
    const { fetchImpl } = stub({
      "contents/": async () => ({ ok: false, status, json: async () => ({ message: "conflict" }) })
    });
    const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
    await assert.rejects(
      () => gh.putFile({ path: "a.json", content: "{}", message: "m", sha: "stale" }),
      ConflictError,
      `status ${status} should be a conflict`
    );
  }
});

test("other failures throw with the API message", async () => {
  const { fetchImpl } = stub({
    "contents/": async () => ({ ok: false, status: 500, json: async () => ({ message: "boom" }) })
  });
  const gh = createClient({ token: "t", repo: "o/r", branch: "prod", fetchImpl });
  await assert.rejects(() => gh.putFile({ path: "a.json", content: "{}", message: "m" }), /boom/);
});

test("the token is sent as a bearer credential and never in the URL", async () => {
  const { fetchImpl, calls } = stub({
    "contents/": async () => ({ ok: true, status: 200, json: async () => ({ commit: {} }) })
  });
  const gh = createClient({ token: "secret-token", repo: "o/r", branch: "prod", fetchImpl });
  await gh.putFile({ path: "a.json", content: "{}", message: "m" });

  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer secret-token");
  assert.ok(!calls.at(-1).url.includes("secret-token"), "token must not appear in the URL");
});
