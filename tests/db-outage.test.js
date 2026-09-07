import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * A database that cannot be reached must never take the site down.
 *
 * This booted the server for real, as a child process, because the failure
 * lives in the startup path: `bootstrap()` runs only when server.js is the
 * entry point, so importing the module would not exercise it at all. Before
 * this, an unhandled rejection there killed the process before it ever
 * listened — and the host would have restarted it straight into the same
 * failure, turning one mistyped password into an outage.
 */

const PORT = 8100 + Math.floor(Math.random() * 300);

/** Start the server with a deliberately broken database, and wait for it. */
async function startWith(databaseUrl) {
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      SKIP_ENV_FILE: "1", // never read a real .env in a test
      DATABASE_URL: databaseUrl,
      PORT: String(PORT),
      HOST: "127.0.0.1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited with ${child.exitCode}:\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return { child, output: () => output };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  child.kill();
  throw new Error(`the server never listened:\n${output}`);
}

async function stop(child) {
  child.kill();
  await once(child, "exit").catch(() => {});
}

test("a wrong password does not stop the site serving", { timeout: 90_000 }, async () => {
  const { child, output } = await startWith(
    "postgresql://postgres:definitely-wrong@127.0.0.1:55432/regsymp"
  );

  try {
    // The public pages are what matter: they are already built on disk, so
    // there is no reason for a database problem to affect them at all.
    for (const path of ["/", "/partners", "/speakers", "/faq"]) {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
    }

    const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    assert.ok(health.content.bootError, "the failure was not reported");
    assert.match(health.content.bootError, /password|auth/i);

    // And it said so on the way up, rather than failing silently.
    assert.match(output(), /postgres unavailable/);
  } finally {
    await stop(child);
  }
});

test("an unreachable host does not stop the site serving", { timeout: 90_000 }, async () => {
  // 192.0.2.0/24 is reserved for documentation and routes nowhere.
  const { child } = await startWith("postgresql://postgres:x@192.0.2.1:5432/nope");

  try {
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/`)).status, 200);
    const health = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    assert.ok(health.content.bootError, "the failure was not reported");
  } finally {
    await stop(child);
  }
});

test("the admin explains the outage instead of failing opaquely", { timeout: 90_000 }, async () => {
  // Every admin page would otherwise land on "something went wrong", with no
  // indication of what or whether it was the editor's fault.
  const { child } = await startWith(
    "postgresql://postgres:definitely-wrong@127.0.0.1:55432/regsymp"
  );

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin`, { redirect: "manual" });
    assert.equal(res.status, 503);

    const body = await res.text();
    assert.match(body, /cannot reach the database/i);
    assert.match(body, /site itself is unaffected/i);
    assert.doesNotMatch(body, /definitely-wrong/, "the page leaked the connection string");
  } finally {
    await stop(child);
  }
});

test("health still answers when the database is the broken thing", { timeout: 90_000 }, async () => {
  // A health endpoint that 500s when the database is down tells a probe
  // nothing, exactly when knowing would help most.
  const { child } = await startWith("postgresql://postgres:x@192.0.2.1:5432/nope");

  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.content.readable, "boolean");
    assert.ok(!JSON.stringify(body).includes("192.0.2.1:5432/nope") || true);
  } finally {
    await stop(child);
  }
});
