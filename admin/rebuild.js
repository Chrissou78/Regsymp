import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * Rebuild the site inside this process.
 *
 * Saving used to mean committing, and committing triggered a redeploy: three
 * to five minutes before the change appeared, and every admin signed out when
 * the replacement container took over. Building here takes under a second and
 * disturbs nothing.
 *
 * Builds are chained rather than run concurrently, because two Eleventy
 * instances writing the same output directory would race over the same files.
 */

let chain = Promise.resolve();
let last = null;
let prepare = null;

/**
 * Something to do before every build.
 *
 * Events live in a table, and the templates read them the way they read any
 * other content: out of src/_data. Materialising them here rather than at the
 * call sites means every build has them fresh -- the one at boot, the one
 * after an admin saves, and the one after an event is made live -- without
 * each of those having to remember.
 */
export function beforeEachBuild(fn) {
  prepare = fn;
}

export function rebuild({ quiet = true } = {}) {
  const run = chain.then(() => build(quiet));
  // Never let one failure poison the chain for every later save.
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function build(quiet) {
  const started = Date.now();
  if (prepare) await prepare();
  const { default: Eleventy } = await import("@11ty/eleventy");
  const eleventy = new Eleventy(path.join(ROOT, "src"), path.join(ROOT, "_site"), {
    quietMode: quiet,
    configPath: path.join(ROOT, "eleventy.config.js")
  });

  try {
    await eleventy.write();
    last = { ok: true, ms: Date.now() - started, at: new Date().toISOString() };
    return last;
  } catch (err) {
    last = { ok: false, error: err.message, ms: Date.now() - started, at: new Date().toISOString() };
    throw err;
  }
}

export function lastBuild() {
  return last;
}
