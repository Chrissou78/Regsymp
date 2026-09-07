import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

/**
 * Nothing tracked by git may contain a live credential.
 *
 * A real Resend key was once typed into `.env.example` — the file whose whole
 * job is to show which names exist — and a `git add -A` swept it into a
 * commit. GitHub's push protection caught it on the way to the public mirror;
 * this catches it before that, where it is still cheap to fix.
 */

/** Shapes that mean "this is a credential, not an example". */
const CREDENTIALS = [
  { name: "Resend API key", pattern: /re_[A-Za-z0-9_-]{16,}/ },
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { name: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "private key block", pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "database URL with a password",
    // A URL carrying credentials. Placeholders are fine; anything else is not.
    pattern: /postgres(?:ql)?:\/\/[^:\s/]+:(?!password\b|pass\b|dev\b|postgres\b|secret\b|x\b|p@ss)[^@\s]{6,}@/
  }
];

/** Files that legitimately contain credential-shaped test fixtures. */
const FIXTURES = new Set(["tests/no-secrets.test.js", "tests/load-env.test.js", "tests/admin-pg.test.js"]);

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

test(".env.example holds names, never values", async () => {
  // The file most likely to be filled in by mistake, because filling it in is
  // exactly what it looks like it is for.
  // A missing file is a failure too, with a message that says what happened:
  // this one was renamed to .env at one point, and an ENOENT stack traceback
  // does not suggest "your template is gone".
  let text;
  try {
    text = await readFile(".env.example", "utf8");
  } catch (err) {
    assert.fail(`.env.example is missing (${err.code}). It is the tracked template — restore it with: git checkout -- .env.example`);
  }
  for (const { name, pattern } of CREDENTIALS) {
    assert.ok(!pattern.test(text), `.env.example contains what looks like a ${name}`);
  }

  // Every uncommented assignment must be empty. A blanket rule, because
  // judging values case by case is exactly how a real Pinata API key sat here
  // looking plausible — it was neither long nor obviously credential-shaped,
  // and no pattern match would have flagged it. Example values belong in the
  // comment above the line, where they cannot be mistaken for configuration.
  const valued = [];
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$/);
    if (match) valued.push(`line ${i + 1}: ${match[1]}`);
  }
  assert.deepEqual(valued, [], `.env.example must hold names only, but:\n  ${valued.join("\n  ")}`);
});

test("no tracked file contains a live credential", async () => {
  const offenders = [];

  for (const file of trackedFiles()) {
    if (FIXTURES.has(file)) continue;
    if (/\.(png|jpe?g|webp|avif|gif|ico|woff2?|mp4|pdf|svg)$/i.test(file)) continue;

    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue; // unreadable or binary; nothing to scan
    }

    for (const { name, pattern } of CREDENTIALS) {
      const hit = text.match(pattern);
      if (hit) offenders.push(`${file}: ${name} (${hit[0].slice(0, 12)}...)`);
    }
  }

  assert.deepEqual(offenders, [], `tracked files contain credentials:\n  ${offenders.join("\n  ")}`);
});

test(".env itself is never tracked", () => {
  // It holds the real values, including the one credential that cannot live
  // in the database.
  const tracked = trackedFiles();
  assert.ok(!tracked.includes(".env"), ".env is tracked by git");

  // check-ignore exits 0 when the path is ignored and 1 when it is not, so
  // the exit status is the answer.
  let ignored = true;
  try {
    execFileSync("git", ["check-ignore", "-q", ".env"], { stdio: "ignore" });
  } catch {
    ignored = false;
  }
  assert.ok(ignored, ".env is not covered by .gitignore");
});
