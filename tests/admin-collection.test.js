import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  serialise,
  resolveList,
  setList,
  applyEdit,
  applyDelete,
  applyMove,
  uniqueFilename
} from "../admin/routes.js";
import { getSchema } from "../admin/schemas.js";

const speakers = getSchema("speakers");
const partners = getSchema("partners");
const agenda = getSchema("agenda");

// ------------------------------------------------------------- serialising

test("serialise matches the formatting of the hand-written data files", async () => {
  const onDisk = await readFile("src/_data/speakers.json", "utf8");
  const parsed = JSON.parse(onDisk);
  assert.equal(
    serialise(parsed),
    onDisk,
    "a no-op edit must not produce a diff against the existing file"
  );
});

// ------------------------------------------------------------ list access

test("resolveList reaches the array for every collection shape", async () => {
  const speakerDoc = JSON.parse(await readFile("src/_data/speakers.json", "utf8"));
  assert.equal(resolveList(speakers, speakerDoc).length, speakerDoc.length);

  const partnerDoc = JSON.parse(await readFile("src/_data/partners.json", "utf8"));
  assert.equal(resolveList(partners, partnerDoc).length, partnerDoc.length, "no key: the tiers");
  assert.equal(
    resolveList(partners, partnerDoc, "1").length,
    partnerDoc[1].logos.length,
    "with a key: that tier's logos"
  );

  const agendaDoc = JSON.parse(await readFile("src/_data/agenda.json", "utf8"));
  assert.equal(resolveList(agenda, agendaDoc, "palma.day1").length, agendaDoc.palma.day1.length);
});

test("setList writes back without disturbing siblings", async () => {
  const partnerDoc = JSON.parse(await readFile("src/_data/partners.json", "utf8"));
  const next = setList(partners, partnerDoc, "1", [{ name: "Only", file: "only.png" }]);

  assert.equal(next[1].logos.length, 1);
  assert.equal(next[1].tier, partnerDoc[1].tier, "the tier's own fields survive");
  assert.deepEqual(next[0], partnerDoc[0], "other tiers are untouched");
  assert.deepEqual(partnerDoc[1].logos.length > 1, true, "the original is not mutated");

  const agendaDoc = JSON.parse(await readFile("src/_data/agenda.json", "utf8"));
  const nextAgenda = setList(agenda, agendaDoc, "palma.day1", [{ time: "09:00", title: "X" }]);
  assert.equal(nextAgenda.palma.day1.length, 1);
  assert.equal(nextAgenda.palma.day2.length, agendaDoc.palma.day2.length, "day2 is untouched");
});

// ----------------------------------------------------------------- edits

test("applyEdit updates an existing record in place", () => {
  const list = [
    { slug: "a", name: "A", role: "R" },
    { slug: "b", name: "B", role: "R" }
  ];
  const out = applyEdit(speakers, list, "0", { name: "A2", role: "R" });
  assert.equal(out.ok, true);
  assert.equal(out.list[0].name, "A2");
  assert.equal(out.list.length, 2);
  assert.equal(list[0].name, "A", "the input list is not mutated");
});

test("applyEdit appends when the index is 'new'", () => {
  const list = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, list, "new", {
    name: "Barbara Pozdorovkina",
    role: "Chief Growth Officer"
  });
  assert.equal(out.list.length, 2);
  assert.equal(out.list[1].slug, "barbara-pozdorovkina");
});

test("applyEdit rejects a duplicate slug", () => {
  const list = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, list, "new", { name: "A", role: "R" });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /already used/i.test(e.message)));
});

test("editing a record does not clash with its own slug", () => {
  const list = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, list, "0", { slug: "a", name: "A", role: "Changed" });
  assert.equal(out.ok, true);
});

test("applyEdit surfaces validation errors without touching the data", () => {
  const list = [{ slug: "a", name: "A", role: "R" }];
  const out = applyEdit(speakers, list, "0", { name: "", role: "R" });
  assert.equal(out.ok, false);
  assert.equal(list[0].name, "A");
});

test("child fields are used for nested collections", () => {
  const list = [{ name: "LMAX Group", file: "lmax-group.png" }];
  const out = applyEdit(partners, list, "new", { name: "New", file: "new.png" }, partners.childFields);
  assert.equal(out.ok, true);
  assert.equal(out.list.length, 2);
});

// ------------------------------------------------------- delete and reorder

test("applyDelete removes the record at the index", () => {
  assert.deepEqual(applyDelete([{ s: "a" }, { s: "b" }], "0"), [{ s: "b" }]);
});

test("applyMove reorders and clamps at the ends", () => {
  const list = [{ s: 1 }, { s: 2 }, { s: 3 }];
  assert.deepEqual(applyMove(list, "2", "up").map((r) => r.s), [1, 3, 2]);
  assert.deepEqual(applyMove(list, "0", "up").map((r) => r.s), [1, 2, 3], "clamped at the top");
  assert.deepEqual(applyMove(list, "2", "down").map((r) => r.s), [1, 2, 3], "clamped at the bottom");
  assert.deepEqual(list.map((r) => r.s), [1, 2, 3], "the input is not mutated");
});

// -------------------------------------------------------------- filenames

test("uniqueFilename avoids overwriting an existing image", () => {
  assert.equal(uniqueFilename("rony-vogel.png", []), "rony-vogel.png");
  assert.equal(uniqueFilename("rony-vogel.png", ["rony-vogel.png"]), "rony-vogel-2.png");
  assert.equal(
    uniqueFilename("rony-vogel.png", ["rony-vogel.png", "rony-vogel-2.png"]),
    "rony-vogel-3.png"
  );
});
