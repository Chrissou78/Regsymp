import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectDelimiter,
  parseAttendees,
  splitLine,
  splitName
} from "../admin/import-attendees.js";

/**
 * Whoever is pasting a hundred people should not have to reshape their data
 * first. Every awkward input anybody might realistically paste is a test
 * here rather than something to find out with real rows.
 */

test("one address per line", () => {
  const { rows, problems } = parseAttendees("ada@example.com\ngrace@example.com");
  assert.equal(problems.length, 0);
  assert.deepEqual(rows.map((r) => r.email), ["ada@example.com", "grace@example.com"]);
});

test("a spreadsheet paste is tab-separated", () => {
  // Copying a block out of Excel or Sheets gives tabs, not commas.
  const text = "Ada\tLovelace\tada@example.com\tEngines";
  assert.equal(detectDelimiter(text), "\t");

  const { rows } = parseAttendees(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "ada@example.com");
  assert.equal(rows[0].firstName, "Ada");
  assert.equal(rows[0].lastName, "Lovelace");
});

test("a CSV with a header maps its columns by name", () => {
  const text = [
    "First name,Surname,Email,Company,Title",
    "Ada,Lovelace,ada@example.com,Engines,Chief Engineer",
    "Grace,Hopper,grace@example.com,Navy,Rear Admiral"
  ].join("\n");

  const { rows, hadHeader, problems } = parseAttendees(text);
  assert.equal(hadHeader, true);
  assert.equal(problems.length, 0);
  assert.deepEqual(rows[0], {
    email: "ada@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    company: "Engines",
    position: "Chief Engineer",
    country: null
  });
  assert.equal(rows[1].position, "Rear Admiral");
});

test("column order does not matter when there is a header", () => {
  const text = ["email,company,first,last", "ada@example.com,Engines,Ada,Lovelace"].join("\n");
  const { rows } = parseAttendees(text);
  assert.equal(rows[0].firstName, "Ada");
  assert.equal(rows[0].company, "Engines");
});

test("header aliases people actually use", () => {
  for (const header of [
    "e-mail,first name,last name",
    "Email Address,Forename,Family name",
    "MAIL,Given name,Surname"
  ]) {
    const { rows, hadHeader } = parseAttendees(`${header}\nada@example.com,Ada,Lovelace`);
    assert.equal(hadHeader, true, header);
    assert.equal(rows[0].email, "ada@example.com", header);
    assert.equal(rows[0].firstName, "Ada", header);
  }
});

test("semicolons, as European spreadsheets export", () => {
  const text = "Email;First;Last\nada@example.com;Ada;Lovelace";
  assert.equal(detectDelimiter(text), ";");
  assert.equal(parseAttendees(text).rows[0].lastName, "Lovelace");
});

test("a name and address from a mail client", () => {
  // Copying recipients out of Outlook or Gmail gives this shape.
  const { rows } = parseAttendees('Ada Lovelace <ada@example.com>\n"Hopper, Grace" <grace@example.com>');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, "ada@example.com");
  assert.equal(rows[0].firstName, "Ada");
  assert.equal(rows[0].lastName, "Lovelace");
  assert.equal(rows[1].email, "grace@example.com");
});

test("quoted fields containing the delimiter", () => {
  const text = 'Email,Company\nada@example.com,"Engines, Analytical"';
  assert.equal(parseAttendees(text).rows[0].company, "Engines, Analytical");
});

test("a doubled quote is a literal quote", () => {
  assert.deepEqual(splitLine('a,"say ""hi""",b', ","), ["a", 'say "hi"', "b"]);
});

test("the address is found wherever it sits", () => {
  // No header, and the address is not first.
  const { rows } = parseAttendees("Ada Lovelace,Engines,ada@example.com");
  assert.equal(rows[0].email, "ada@example.com");
  assert.equal(rows[0].firstName, "Ada");
  assert.equal(rows[0].company, "Engines");
});

test("a multi-word surname stays whole", () => {
  assert.deepEqual(splitName("Martín L. Aleñar Feliu"), {
    firstName: "Martín",
    lastName: "L. Aleñar Feliu"
  });
  assert.deepEqual(splitName("Cher"), { firstName: "Cher", lastName: null });
  assert.deepEqual(splitName("  "), { firstName: null, lastName: null });
});

test("lines with no address are reported, not dropped", () => {
  // A silent drop in an import of a hundred is how somebody ends up missing
  // from the guest list with nobody knowing why.
  const { rows, problems } = parseAttendees(
    ["ada@example.com", "just some text", "not-an-email", "grace@example.com"].join("\n")
  );
  assert.equal(rows.length, 2);
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((p) => p.line), [2, 3]);
  assert.match(problems[0].reason, /no email/);
});

test("a repeat inside the same paste is reported once", () => {
  const { rows, problems } = parseAttendees(
    "ada@example.com\nADA@example.com\ngrace@example.com"
  );
  assert.deepEqual(rows.map((r) => r.email), ["ada@example.com", "grace@example.com"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /repeated/);
});

test("addresses are lowercased, so case cannot create two people", () => {
  assert.equal(parseAttendees("Ada@Example.COM").rows[0].email, "ada@example.com");
});

test("blank lines and stray whitespace are ignored", () => {
  const { rows, problems } = parseAttendees("\n  ada@example.com  \n\n\tgrace@example.com\n\n");
  assert.equal(problems.length, 0);
  assert.equal(rows.length, 2);
});

test("empty input is not an error", () => {
  const { rows, problems } = parseAttendees("");
  assert.deepEqual(rows, []);
  assert.deepEqual(problems, []);
});

test("a header-only paste yields nothing and complains about nothing", () => {
  const { rows, problems, hadHeader } = parseAttendees("Email,First,Last");
  assert.equal(hadHeader, true);
  assert.deepEqual(rows, []);
  assert.deepEqual(problems, []);
});

test("missing trailing columns do not shift the others", () => {
  const text = ["Email,First,Last,Company", "ada@example.com,Ada,Lovelace", "grace@example.com,Grace"].join("\n");
  const { rows } = parseAttendees(text);
  assert.equal(rows[0].company, null);
  assert.equal(rows[1].firstName, "Grace");
  assert.equal(rows[1].lastName, null);
});

test("the real thing: a mixed, messy paste", () => {
  const text = [
    "Email Address,First Name,Surname,Company",
    "ada@example.com,Ada,Lovelace,Engines",
    "",
    'grace@example.com,Grace,Hopper,"Navy, US"',
    "nonsense row with no address",
    "ADA@EXAMPLE.COM,Ada,Duplicate,Engines"
  ].join("\n");

  const { rows, problems } = parseAttendees(text);
  assert.deepEqual(rows.map((r) => r.email), ["ada@example.com", "grace@example.com"]);
  assert.equal(rows[1].company, "Navy, US");
  assert.equal(problems.length, 2);
  assert.deepEqual(problems.map((p) => p.reason).sort(), [
    "no email address found",
    "repeated in this paste"
  ]);
});
