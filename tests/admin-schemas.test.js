import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { SCHEMAS, getSchema, validateRecord } from "../admin/schemas.js";

test("every data file has a schema, and every schema points at a real file", async () => {
  const onDisk = (await readdir("src/_data"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => `src/_data/${f}`);
  const inSchemas = Object.values(SCHEMAS).map((s) => s.file);

  for (const file of onDisk) {
    assert.ok(inSchemas.includes(file), `no schema covers ${file}`);
  }
  for (const file of inSchemas) {
    assert.ok(onDisk.includes(file), `schema points at missing file ${file}`);
  }
});

test("the real data validates against its own schema", async () => {
  const speakers = JSON.parse(await readFile("src/_data/speakers.json", "utf8"));
  const schema = getSchema("speakers");
  for (const record of speakers) {
    const r = validateRecord(schema, record);
    assert.equal(r.ok, true, `${record.name}: ${JSON.stringify(r.errors)}`);
  }
});

test("required fields are enforced", () => {
  const r = validateRecord(getSchema("speakers"), { name: "", role: "CEO" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "name"));
});

test("a slug is derived from the name when absent", () => {
  const r = validateRecord(getSchema("speakers"), {
    name: "Barbara Pozdorovkina",
    role: "Chief Growth Officer"
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.slug, "barbara-pozdorovkina");
});

test("html fields are sanitised rather than rejected", () => {
  const r = validateRecord(getSchema("speakers"), {
    name: "X",
    role: "Y",
    orgHtml: "<strong>Dept</strong><script>alert(1)</script>"
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.orgHtml, "<strong>Dept</strong>");
});

test("max length is enforced", () => {
  const r = validateRecord(getSchema("speakers"), { name: "x".repeat(500), role: "Y" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.field === "name" && /long/i.test(e.message)));
});

test("url fields reject non-http schemes", () => {
  const schema = getSchema("speakers");
  for (const bad of ["javascript:alert(1)", "ftp://x.com", "not a url", "data:text/html,x"]) {
    const r = validateRecord(schema, { name: "X", role: "Y", linkedin: bad });
    assert.equal(r.ok, false, `${bad} should be rejected`);
  }
  const good = validateRecord(schema, {
    name: "X",
    role: "Y",
    linkedin: "https://www.linkedin.com/in/x/"
  });
  assert.equal(good.ok, true);
});

test("empty optional fields are omitted, not stored as empty strings", () => {
  const r = validateRecord(getSchema("speakers"), {
    name: "X",
    role: "Y",
    bio: "",
    linkedin: ""
  });
  assert.equal(r.ok, true);
  assert.ok(!("bio" in r.value));
  assert.ok(!("linkedin" in r.value));
});

test("checkbox fields are only present when true", () => {
  const schema = getSchema("agenda");
  const on = validateRecord(schema, { time: "08:30", title: "Breakfast", break: "on" });
  assert.equal(on.value.break, true);
  const off = validateRecord(schema, { time: "09:30", title: "Keynote" });
  assert.ok(!("break" in off.value));
});

test("child fields validate independently for nested collections", () => {
  const schema = getSchema("partners");
  const r = validateRecord(schema, { name: "LMAX Group", file: "lmax-group.png" }, schema.childFields);
  assert.equal(r.ok, true);
  assert.equal(r.value.name, "LMAX Group");
  const missing = validateRecord(schema, { name: "X" }, schema.childFields);
  assert.equal(missing.ok, false);
});

test("getSchema does not leak prototype properties", () => {
  assert.equal(getSchema("constructor"), undefined);
  assert.equal(getSchema("__proto__"), undefined);
});
