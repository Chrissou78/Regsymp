import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load a .env file, if there is one.
 *
 * This has to be the first import in server.js: module bodies run after all
 * their imports, so anything reading process.env at module scope — the
 * database URL among them — sees these values only if they are set first.
 *
 * Why it exists: DATABASE_URL was put in a .env file on the host and silently
 * did nothing, because nothing here had ever read one. Host-injected variables
 * were the only ones that worked, which is not what a file called .env
 * suggests to anybody.
 *
 * Values already in the environment win. A real host variable is more
 * specific than a file checked into the image, and overriding it would make
 * the dashboard mysteriously ineffective.
 */

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

export function parseEnv(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Tolerate `export KEY=value`, which is what a shell-minded person writes.
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();
    // Strip one matched pair of wrapping quotes, and nothing else: a password
    // may legitimately contain a quote character.
    const quoted = value.match(/^(['"])([\s\S]*)\1$/);
    value = quoted ? quoted[2] : value;
    out.set(key, value);
  }
  return out;
}

export function loadEnv({ files = [".env"], root = ROOT, env = process.env } = {}) {
  // An explicit opt-out, because deleting a variable before importing is not
  // one: the delete makes it absent, and absent is exactly when this loads it
  // from the file. The tests set this so a real .env cannot reach them.
  if (env.SKIP_ENV_FILE) return { file: null, applied: [], skipped: [], disabled: true };

  const applied = [];
  const skipped = [];
  let found = null;

  for (const name of files) {
    let text;
    try {
      text = readFileSync(path.join(root, name), "utf8");
    } catch {
      continue; // no such file: normal, and not an error
    }
    found = name;

    for (const [key, value] of parseEnv(text)) {
      if (env[key] !== undefined && env[key] !== "") {
        skipped.push(key);
        continue;
      }
      env[key] = value;
      applied.push(key);
    }
    break;
  }

  return { file: found, applied, skipped };
}

export const loaded = loadEnv();
