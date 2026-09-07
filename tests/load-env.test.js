import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnv, parseEnv } from "../admin/load-env.js";

const temp = () => mkdtemp(path.join(tmpdir(), "regsymp-env-"));

test("a plain assignment is read", () => {
  assert.equal(parseEnv("DATABASE_URL=postgresql://u:p@h:5432/db").get("DATABASE_URL"),
    "postgresql://u:p@h:5432/db");
});

test("comments and blank lines are ignored", () => {
  const parsed = parseEnv(["# a comment", "", "  ", "KEY=value", "# KEY=other"].join("\n"));
  assert.deepEqual([...parsed], [["KEY", "value"]]);
});

test("a value containing = survives intact", () => {
  // JWTs are base64 and end in padding; splitting on every = truncates them
  // into something that fails authentication looking like a wrong key.
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0=.sig==";
  assert.equal(parseEnv(`PINATA_JWT=${jwt}`).get("PINATA_JWT"), jwt);
});

test("a connection string with symbols survives intact", () => {
  const url = "postgresql://postgres:p@ss:w0rd!@91.99.21.245:44993/postgres?sslmode=require";
  assert.equal(parseEnv(`DATABASE_URL=${url}`).get("DATABASE_URL"), url);
});

test("one matched pair of wrapping quotes is stripped", () => {
  assert.equal(parseEnv('RESEND_FROM="RegSymp <a@b.c>"').get("RESEND_FROM"), "RegSymp <a@b.c>");
  assert.equal(parseEnv("KEY='value'").get("KEY"), "value");
  // An unmatched quote is part of the value: a password may contain one.
  assert.equal(parseEnv('KEY="half').get("KEY"), '"half');
  assert.equal(parseEnv("KEY=pa'ss").get("KEY"), "pa'ss");
});

test("an export prefix is tolerated", () => {
  // What somebody used to a shell writes.
  assert.equal(parseEnv("export DATABASE_URL=postgres://x").get("DATABASE_URL"), "postgres://x");
});

test("malformed lines are skipped rather than throwing", () => {
  const parsed = parseEnv(["no-equals-here", "=novalue", "1BAD=x", "GOOD=y"].join("\n"));
  assert.deepEqual([...parsed], [["GOOD", "y"]]);
});

test("values are applied to the environment", async () => {
  const root = await temp();
  await writeFile(path.join(root, ".env"), "DATABASE_URL=postgres://from-file\nPINATA_JWT=jwt-value\n");

  const env = {};
  const result = loadEnv({ root, env });

  assert.equal(result.file, ".env");
  assert.deepEqual(result.applied.sort(), ["DATABASE_URL", "PINATA_JWT"]);
  assert.equal(env.DATABASE_URL, "postgres://from-file");
});

test("a variable already in the environment wins over the file", async () => {
  // A real host variable is more specific than a file in the image. Overriding
  // it would make the host dashboard mysteriously ineffective.
  const root = await temp();
  await writeFile(path.join(root, ".env"), "DATABASE_URL=postgres://from-file\n");

  const env = { DATABASE_URL: "postgres://from-host" };
  const result = loadEnv({ root, env });

  assert.equal(env.DATABASE_URL, "postgres://from-host");
  assert.deepEqual(result.skipped, ["DATABASE_URL"]);
  assert.deepEqual(result.applied, []);
});

test("an empty existing value does not shadow the file", async () => {
  // Host dashboards happily store an empty string, which is not a setting.
  const root = await temp();
  await writeFile(path.join(root, ".env"), "DATABASE_URL=postgres://from-file\n");

  const env = { DATABASE_URL: "" };
  loadEnv({ root, env });
  assert.equal(env.DATABASE_URL, "postgres://from-file");
});

test("SKIP_ENV_FILE disables the loader entirely", async () => {
  // This is what keeps a production .env out of the test run. Deleting a
  // variable cannot do it: absent is when the loader fills it in.
  const root = await temp();
  await writeFile(path.join(root, ".env"), "DATABASE_URL=postgres://from-file\n");

  const env = { SKIP_ENV_FILE: "1" };
  const result = loadEnv({ root, env });

  assert.equal(result.disabled, true);
  assert.equal(env.DATABASE_URL, undefined, "the file was read despite the opt-out");
  assert.deepEqual(result.applied, []);
});

test("no .env file is normal, not an error", async () => {
  const result = loadEnv({ root: await temp(), env: {} });
  assert.equal(result.file, null);
  assert.deepEqual(result.applied, []);
});
