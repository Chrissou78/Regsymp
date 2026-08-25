import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const OUT = "_site";

/** Read one built file from _site. `npm test` builds before running tests. */
export function readOutput(relPath) {
  return readFile(path.join(OUT, relPath), "utf8");
}

/** Every built .html file, as paths relative to _site. */
export async function htmlFiles(dir = OUT) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith(".html")) found.push(full);
  }
  return found;
}

/** The eight content pages, as _site-relative paths. */
export const PAGES = [
  "index.html",
  "speakers/index.html",
  "partners/index.html",
  "pillars/index.html",
  "faq/index.html",
  "legal/index.html",
  "london-2027/index.html",
  "luxembourg-2027/index.html"
];
