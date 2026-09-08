import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readOutput, htmlFiles, PAGES } from "./helpers/output.js";

const speakers = JSON.parse(await readFile("src/_data/speakers.json", "utf8"));
const faq = JSON.parse(await readFile("src/_data/faq.json", "utf8"));
const agenda = JSON.parse(await readFile("src/_data/agenda.json", "utf8"));

// ---------------------------------------------------------------- shared chrome

test("every page has nav, drawer and footer", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.match(html, /class="nav/, `${p} missing nav`);
    assert.match(html, /id="drawer"/, `${p} missing mobile drawer`);
    assert.match(html, /class="footer/, `${p} missing footer`);
  }
});

test("every page has a canonical URL and OG tags", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.regsymp\.com/, `${p} canonical`);
    assert.match(html, /<meta property="og:title"/, `${p} og:title`);
    assert.match(html, /<meta property="og:image"/, `${p} og:image`);
  }
});

test("exactly one h1 per page", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    const count = (html.match(/<h1[\s>]/g) || []).length;
    assert.equal(count, 1, `${p} has ${count} h1 elements`);
  }
});

// -------------------------------------------------------------------- images

test("every image has explicit width and height", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    for (const img of html.match(/<img[^>]*>/g) || []) {
      assert.match(img, /width="\d+"/, `${p}: missing width -> ${img.slice(0, 90)}`);
      assert.match(img, /height="\d+"/, `${p}: missing height -> ${img.slice(0, 90)}`);
    }
  }
});

test("no image reference uses the old capitalised Speakers path", async () => {
  // Four cards used assets/speakers vs assets/Speakers, which 404s on Linux.
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.doesNotMatch(html, /assets\/Speakers\//, `${p} still uses assets/Speakers/`);
  }
});

// ------------------------------------------------------------------- content

test("all speakers render, with photos", async () => {
  const html = await readOutput("speakers/index.html");
  for (const s of speakers) {
    assert.ok(html.includes(s.name), `missing card for ${s.name}`);
  }
  const cards = (html.match(/class="speaker-page-card"/g) || []).length;
  assert.equal(cards, speakers.length);
});

test("agenda is rendered server-side, not injected by JS", async () => {
  const html = await readOutput("index.html");
  const rows = (html.match(/class="agenda-row/g) || []).length;
  const expected = agenda.palma.day1.length + agenda.palma.day2.length;
  assert.equal(rows, expected, `expected ${expected} agenda rows in the HTML`);
});

test("five programme themes render", async () => {
  const html = await readOutput("index.html");
  assert.equal((html.match(/class="theme-row"/g) || []).length, 5);
});

test("visible FAQ and FAQPage schema cannot disagree", async () => {
  const html = await readOutput("faq/index.html");
  for (const entry of faq) {
    assert.ok(html.includes(entry.question), `question missing from page: ${entry.question}`);
  }
  assert.equal((html.match(/<details class="faq-item">/g) || []).length, faq.length);
});

// -------------------------------------------------------------------- schema

test("Person schema lives on the speakers page, not the homepage", async () => {
  const speakersHtml = await readOutput("speakers/index.html");
  const homeHtml = await readOutput("index.html");
  assert.match(speakersHtml, /"@type": "Person"/);
  assert.doesNotMatch(homeHtml, /"@type": "Person"/);
});

test("no schema points at the dead #speakers anchor", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.doesNotMatch(html, /regsymp\.com\/#speakers/, `${p} references the removed anchor`);
  }
});

test("all JSON-LD blocks parse", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
    for (const block of blocks) {
      const json = block.replace(/<\/?script[^>]*>/g, "");
      assert.doesNotThrow(() => JSON.parse(json), `${p}: invalid JSON-LD`);
    }
  }
});

// ------------------------------------------------------- signing in and out

test("every page offers a way into an account, and no invitation form", async () => {
  // The invitation modal was retired when registration opened: anybody who
  // wants in creates an account, and the organisers issue a badge.
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.match(html, /data-account-link/, `${p} has no way to sign in`);
    assert.match(html, /\/portal\/signin/, `${p} does not link to sign in`);
    assert.doesNotMatch(html, /id="inviteModal"/, `${p} still carries the invitation modal`);
    assert.doesNotMatch(html, /data-invite-trigger/, `${p} still triggers the invitation modal`);
  }
});

test("the admin link ships hidden, for the browser to reveal", async () => {
  // These pages are static, so the menu cannot know who is signed in at build
  // time. It ships hidden and site.js reveals it from a readable cookie, which
  // grants nothing because every route still checks the real session.
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.match(html, /data-admin-link/, `${p} has no admin link`);
    assert.match(html, /data-admin-link[^>]*hidden/, `${p} shows the admin link to everybody`);
  }
});

test("no internal link points at a missing page", async () => {
  const files = await htmlFiles();
  const pages = new Set(
    files.map(
      (f) => "/" + path.relative("_site", f).replace(/\\/g, "/").replace(/index\.html$/, "")
    )
  );
  const broken = [];
  for (const file of files) {
    const html = await readFile(file, "utf8");
    for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1];
      // Some destinations are served by the server rather than built by
      // Eleventy, so they are not among the output files: the admin, the
      // attendee portal, and the check-in URL a badge's QR points at.
      if (
        href.startsWith("/assets/") ||
        href.startsWith("/img/") ||
        href.startsWith("/api/") ||
        href.startsWith("/admin") ||
        href.startsWith("/portal") ||
        href.startsWith("/t/")
      ) {
        continue;
      }
      const withSlash = href.endsWith("/") ? href : href + "/";
      if (!pages.has(withSlash) && !pages.has(href)) {
        broken.push(`${path.relative("_site", file)} -> ${href}`);
      }
    }
  }
  assert.deepEqual(broken, [], `broken internal links:\n${broken.join("\n")}`);
});

test("no .html links survive the migration", async () => {
  for (const p of PAGES) {
    const html = await readOutput(p);
    assert.doesNotMatch(html, /href="[a-z0-9-]+\.html"/i, `${p} still links to a .html file`);
  }
});

// --------------------------------------------------------------- sitemap etc

test("sitemap lists the indexable pages and robots points at it", async () => {
  const sitemap = await readOutput("sitemap.xml");
  for (const url of ["/", "/speakers/", "/partners/", "/faq/", "/legal/", "/pillars/"]) {
    assert.ok(sitemap.includes(`<loc>https://www.regsymp.com${url}</loc>`), `sitemap missing ${url}`);
  }
  const robots = await readOutput("robots.txt");
  assert.match(robots, /Sitemap: https:\/\/www\.regsymp\.com\/sitemap\.xml/);
});

test("the no-store cache meta tags are gone", async () => {
  const html = await readOutput("index.html");
  assert.doesNotMatch(html, /http-equiv="Cache-Control"/);
  assert.doesNotMatch(html, /no-store/);
});
