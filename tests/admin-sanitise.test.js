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
    ["Armando Grieco_Banca Sella.jpg", "armando-grieco-banca-sella.jpg"],
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
  assert.throws(() => slugifyFilename("noextension"), /filename/i);
});

test("slugify makes record slugs", () => {
  assert.equal(slugify("Barbara Pozdorovkina"), "barbara-pozdorovkina");
  assert.equal(slugify("Martín L. Aleñar Feliu"), "martin-l-alenar-feliu");
  assert.equal(slugify("  Spaced  Out  "), "spaced-out");
  assert.equal(slugify("Banco de España"), "banco-de-espana");
});

test("sanitiseHtml keeps the allowlist and drops everything else", () => {
  const allow = ["strong", "em", "br"];
  assert.equal(sanitiseHtml("<strong>Bold</strong>, plain", allow), "<strong>Bold</strong>, plain");
  assert.equal(sanitiseHtml("<script>alert(1)</script>hi", allow), "hi");
  assert.equal(sanitiseHtml('<img src=x onerror="alert(1)">', allow), "");
  assert.equal(sanitiseHtml('<strong class="x">a</strong>', allow), "<strong>a</strong>");
  assert.equal(sanitiseHtml('<a href="javascript:alert(1)">x</a>', allow), "x");
  assert.equal(sanitiseHtml("", allow), "");
  assert.equal(sanitiseHtml(undefined, allow), "");
});

test("sanitiseHtml survives nested and overlapping attempts", () => {
  const allow = ["strong"];
  // the stray "<scr" is escaped rather than deleted: safe and lossless
  assert.equal(sanitiseHtml("<scr<script>ipt>alert(1)</script>ok", allow), "&lt;scrok");
  assert.equal(sanitiseHtml("<STYLE>body{}</STYLE>text", allow), "text");
});

test("the real orgHtml value is preserved intact", () => {
  const real =
    "<strong>Counterterrorism and Organized Crime Intelligence Center</strong>, " +
    "State Secretariat for Security — Ministry of the Interior";
  assert.equal(sanitiseHtml(real, ["strong", "em", "br"]), real);
});
