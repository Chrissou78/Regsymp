import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSubmission } from "../api/_lib/validate.js";

const valid = {
  name: "Jane Doe",
  email: "jane@example.com",
  company: "Example Bank",
  role: "Head of Payments",
  mobile: "",
  message: "",
  consent: "yes",
  website: "",
  startedAt: String(Date.now() - 10_000)
};

test("accepts a complete submission", () => {
  const r = validateSubmission(valid);
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "Jane Doe");
  assert.equal(r.data.role, "Head of Payments");
});

test("rejects a filled honeypot", () => {
  assert.equal(validateSubmission({ ...valid, website: "http://spam.example" }).ok, false);
});

test("rejects submissions faster than three seconds", () => {
  assert.equal(validateSubmission({ ...valid, startedAt: String(Date.now() - 500) }).ok, false);
});

test("requires name, email, company and role", () => {
  for (const field of ["name", "email", "company", "role"]) {
    assert.equal(validateSubmission({ ...valid, [field]: "" }).ok, false, `${field} should be required`);
  }
});

test("mobile and message stay optional", () => {
  assert.equal(validateSubmission({ ...valid, mobile: "", message: "" }).ok, true);
});

test("requires consent", () => {
  assert.equal(validateSubmission({ ...valid, consent: "" }).ok, false);
});

test("rejects a malformed email", () => {
  for (const bad of ["not-an-email", "a@b", "@example.com", "jane@"]) {
    assert.equal(validateSubmission({ ...valid, email: bad }).ok, false, `should reject ${bad}`);
  }
});

test("trims and length-caps every field", () => {
  const r = validateSubmission({ ...valid, name: "  Jane  ", message: "x".repeat(5000) });
  assert.equal(r.data.name, "Jane");
  assert.equal(r.data.message.length, 2000);
});

test("tolerates a missing startedAt rather than rejecting", () => {
  const { startedAt, ...withoutTimestamp } = valid;
  assert.equal(validateSubmission(withoutTimestamp).ok, true);
});
