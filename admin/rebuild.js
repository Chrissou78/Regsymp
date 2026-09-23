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

/**
 * Build the site somewhere else, from data somebody else supplies.
 *
 * Used to preview a draft event. It joins the same chain as an ordinary build
 * rather than running beside one, because both read src/_data and the preview
 * has to put a draft's speakers there for the length of its build. Two builds
 * at once would mean one of them reading the other's data -- and the one that
 * lost would be the live site.
 *
 * `restore` runs whether the build worked or not. Leaving a draft's content in
 * src/_data would put it on the live site at the next save.
 */
export function buildInto({ outDir, swapIn, restore, quiet = true }) {
  const run = chain.then(async () => {
    try {
      await swapIn();
      return await build(quiet, outDir, { prepared: true });
    } finally {
      await restore();
    }
  });
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function build(quiet, outDir = path.join(ROOT, "_site"), { prepared = false } = {}) {
  const started = Date.now();
  if (prepare && !prepared) await prepare();
  const { default: Eleventy } = await import("@11ty/eleventy");

  // Through the environment, not the constructor: eleventy.config.js sets
  // dir.output and that wins. Safe to set here because builds are chained, so
  // only one is ever running -- and restored in the finally below, or the next
  // ordinary build would write wherever the last preview did.
  const previousOut = process.env.ELEVENTY_OUTPUT_DIR;
  process.env.ELEVENTY_OUTPUT_DIR = outDir;

  const eleventy = new Eleventy(path.join(ROOT, "src"), outDir, {
    quietMode: quiet,
    configPath: path.join(ROOT, "eleventy.config.js")
  });

  const live = outDir === path.join(ROOT, "_site");

  const restoreOut = () => {
    if (previousOut === undefined) delete process.env.ELEVENTY_OUTPUT_DIR;
    else process.env.ELEVENTY_OUTPUT_DIR = previousOut;
  };

  try {
    await eleventy.write();
    const record = { ok: true, ms: Date.now() - started, at: new Date().toISOString() };
    // Only the live build is the site's last build. A preview reporting itself
    // as one would make /api/health describe a page nobody is being served.
    if (live) last = record;
    return record;
  } catch (err) {
    const record = { ok: false, error: err.message, ms: Date.now() - started, at: new Date().toISOString() };
    if (live) last = record;
    throw err;
  } finally {
    restoreOut();
  }
}

export function lastBuild() {
  return last;
}
