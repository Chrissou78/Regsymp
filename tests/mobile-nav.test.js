import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * The mobile navigation was unreachable in production: `.nav-links` is
 * hidden below 1080px and the drawer is the only way to reach Speakers,
 * Partners and the rest — but the ~184px "Request an Invitation" text CTA
 * pushed the burger button to x=434 on a 375px viewport, outside the
 * viewport, where the nav clipped it. There was no way to open the menu.
 *
 * These assert the rules that keep the burger reachable. They are
 * deliberately CSS-source assertions rather than layout measurements, so
 * they run in the normal suite without a browser.
 */

const CSS = await readFile("_site/assets/css/styles.css", "utf8");

function mobileBlock() {
  const start = CSS.indexOf("@media (max-width: 1080px)");
  assert.notEqual(start, -1, "the 1080px breakpoint block is missing");
  // walk to the matching closing brace
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error("unterminated media block");
}

test("the desktop nav links are hidden below the breakpoint", () => {
  assert.match(mobileBlock(), /\.nav-links\s*\{\s*display:\s*none/);
});

test("the text CTA is hidden so the burger fits", () => {
  const block = mobileBlock();
  assert.match(
    block,
    /\.nav-intro-link\s*,\s*\.nav-write-link\s*\{\s*display:\s*none/,
    "without this the burger is pushed outside a 375px viewport"
  );
});

test("the burger itself is never hidden below the breakpoint", () => {
  const block = mobileBlock();
  assert.doesNotMatch(
    block,
    /\.nav-burger[^{]*\{[^}]*display:\s*none/,
    "hiding the burger would leave no way to open the menu"
  );
});

test("the drawer still carries every navigation destination", async () => {
  const html = await readFile("_site/index.html", "utf8");
  const drawer = html.slice(html.indexOf('id="drawer"'), html.indexOf("</aside>"));
  for (const target of ["/speakers/", "/partners/", "/pillars/", "/faq/", "/#agenda", "/#about"]) {
    assert.ok(drawer.includes(`href="${target}"`), `drawer is missing ${target}`);
  }
  assert.match(drawer, /data-invite-trigger/, "drawer must keep the invitation CTA");
});

test("the burger controls the drawer and reports its state", async () => {
  const html = await readFile("_site/index.html", "utf8");
  assert.match(html, /id="burger"[^>]*aria-controls="drawer"/);
  assert.match(html, /id="burger"[^>]*aria-expanded="false"/);
});

test("the drawer has both a closed and an open state defined", () => {
  assert.match(CSS, /\.drawer\s*\{[^}]*transform:\s*translateX\(100%\)/);
  assert.match(CSS, /\.drawer\.open\s*\{[^}]*transform:\s*translateX\(0\)/);
  assert.match(CSS, /\.drawer\.open\s*\{[^}]*visibility:\s*visible/);
});

test("stylesheet and script URLs carry a content hash", async () => {
  // Without this, a browser holding a cached copy never sees a CSS change —
  // and clients that cached it under the old `immutable` header will not even
  // revalidate. Changing the URL is the only thing that reaches them.
  const html = await readFile("_site/index.html", "utf8");
  assert.match(
    html,
    /href="\/assets\/css\/styles\.css\?v=[a-f0-9]{10}"/,
    "styles.css must be cache-busted"
  );
  assert.match(
    html,
    /src="\/assets\/js\/site\.js\?v=[a-f0-9]{10}"/,
    "site.js must be cache-busted"
  );
});

test("the hash changes when the file changes", async () => {
  const { createHash } = await import("node:crypto");
  const css = await readFile("src/assets/css/styles.css");
  const expected = createHash("sha1").update(css).digest("hex").slice(0, 10);
  const html = await readFile("_site/index.html", "utf8");
  assert.ok(
    html.includes(`styles.css?v=${expected}`),
    "the built hash must match the current stylesheet contents"
  );
});
