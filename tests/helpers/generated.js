import { readFile, writeFile } from "node:fs/promises";
import { rebuild } from "../../admin/rebuild.js";

/**
 * Put back what booting the server overwrites.
 *
 * The server writes what the site is built from -- events, speakers, partners
 * -- out of the database and onto disk, and rebuilds _site with it. A test
 * that boots it against an empty test database therefore leaves the checkout
 * holding the test database's idea of the world.
 *
 * That has bitten twice: once as an `events.json` full of test leftovers that
 * reached a commit, and once as two speaker tests failing for reasons that had
 * nothing to do with them, because _site had been rebuilt from nothing.
 *
 * So: put the sources back, and build again from them.
 */
const GENERATED = ["src/_data/events.json", "src/_data/speakers.json", "src/_data/partners.json"];

export async function keepingGenerated(fn) {
  const before = await Promise.all(
    GENERATED.map((f) => readFile(f, "utf8").then((c) => [f, c], () => null))
  );
  try {
    return await fn();
  } finally {
    let changed = false;
    for (const kept of before) {
      if (!kept) continue;
      const now = await readFile(kept[0], "utf8").catch(() => null);
      if (now === kept[1]) continue;
      await writeFile(kept[0], kept[1], "utf8").catch(() => {});
      changed = true;
    }
    if (changed) await rebuild({ quiet: true }).catch(() => {});
  }
}
