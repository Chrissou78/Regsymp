# RegSymp Site Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the eight hand-maintained HTML pages as an Eleventy site with data-driven content, build-time image optimisation and a working invitation request form, while keeping the rendered output visually identical.

**Architecture:** Eleventy 3 generates static HTML into `_site/` from templates in `src/`. Content that appears more than once (FAQ text, speaker details, agenda rows) lives in `src/_data/*.json` and is rendered wherever it is needed, so copies cannot drift. Images are optimised at build by `eleventyImageTransformPlugin`. A single Vercel serverless function at `api/request-invitation.js` sends form submissions via Resend.

**Tech Stack:** Eleventy 3.1.6, @11ty/eleventy-img 7.0.0, resend 6.22.1, Nunjucks templates, Node's built-in `node:test` runner, Vercel hosting.

## Global Constraints

- **Node >= 22.** `@11ty/eleventy-img` 7 requires it. Local machine runs Node 24.18.1.
- **Visual output must stay identical.** The only permitted visible changes are: the FAQ page gaining a mobile nav, and the homepage closing section's heading/copy (see Task 12).
- **URLs must not change:** `/`, `/speakers`, `/partners`, `/pillars`, `/faq`, `/legal`, `/london-2027`, `/luxembourg-2027`.
- **`package.json` must set `"type": "module"`.** All JS uses ESM `import`, not `require`.
- **Never commit secrets.** `RESEND_API_KEY` is set in the Vercel dashboard only.
- **Copy is British English** ("programme", "organised", "tokenisation"). Match the existing source.
- **Brand colours and fonts come from the existing `styles.css`.** Do not restyle.
- The existing `styles.css` (1,751 lines) moves to `src/assets/css/styles.css` **unmodified** except where a task explicitly says otherwise.
- Commit after every task. Never use `--no-verify`.

---

### Task 1: Toolchain, build skeleton and test harness

Establishes the Eleventy build and a test that asserts against built output. Nothing renders correctly yet — that is expected. This task exists so every later task has a working build and a place to put tests.

**Files:**
- Create: `package.json`
- Create: `.eleventy.js`
- Create: `src/index.njk` (temporary placeholder, replaced in Task 5)
- Create: `tests/helpers/build.js`
- Create: `tests/build.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `buildSite()` from `tests/helpers/build.js`, an async function that runs Eleventy programmatically and resolves once `_site/` is written. Later test files import it. Also produces the npm scripts `build`, `serve` and `test`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "regsymp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "eleventy",
    "serve": "eleventy --serve --port=8091",
    "test": "npm run build && node --test tests/"
  },
  "devDependencies": {
    "@11ty/eleventy": "3.1.6",
    "@11ty/eleventy-img": "7.0.0"
  },
  "dependencies": {
    "resend": "6.22.1"
  },
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 2: Create `.eleventy.js`**

Eleventy 3 uses ESM config exporting a default function.

```js
export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "src/assets/css": "assets/css" });
  eleventyConfig.addPassthroughCopy({ "src/assets/js": "assets/js" });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
```

- [ ] **Step 3: Create the placeholder `src/index.njk`**

```njk
---
title: RegSymp
---
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{{ title }}</title></head>
<body><h1>RegSymp</h1></body></html>
```

- [ ] **Step 4: Add `_site/` and `node_modules/` to `.gitignore`**

Append these two lines to the existing `.gitignore`:

```
node_modules/
_site/
```

- [ ] **Step 5: Create the build helper `tests/helpers/build.js`**

```js
import Eleventy from "@11ty/eleventy";
import { readFile } from "node:fs/promises";
import path from "node:path";

let built = false;

export async function buildSite() {
  if (built) return;
  const eleventy = new Eleventy("src", "_site", { quietMode: true });
  await eleventy.write();
  built = true;
}

export async function readOutput(relPath) {
  return readFile(path.join("_site", relPath), "utf8");
}
```

- [ ] **Step 6: Write the failing test `tests/build.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";

test("build produces a homepage", async () => {
  await buildSite();
  const html = await readOutput("index.html");
  assert.match(html, /<html lang="en"/);
});
```

- [ ] **Step 7: Install and run the test**

Run: `npm install && npm test`
Expected: PASS. If Eleventy cannot resolve `src/`, the config `dir.input` is wrong.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .eleventy.js .gitignore src/ tests/
git commit -m "Add Eleventy build skeleton and test harness"
```

---

### Task 2: Site data and base layout

Creates the single `<head>` that every page inherits, ending the situation where `speakers.html`, `partners.html` and `legal.html` have no canonical or OG tags at all.

**Files:**
- Create: `src/_data/site.json`
- Create: `src/_includes/layouts/base.njk`
- Modify: `src/index.njk`
- Modify: `tests/build.test.js`

**Interfaces:**
- Consumes: `buildSite()`, `readOutput()` from Task 1.
- Produces: the `base.njk` layout. Pages opt in via front matter `layout: layouts/base.njk` and may set `title`, `description`, `permalink`, `ogImage` and `noindex`. The global `site` object exposes `site.url`, `site.name`, `site.email`, `site.linkedin`, `site.twitter`.

- [ ] **Step 1: Create `src/_data/site.json`**

Values copied verbatim from the current `index.html` head and footer.

```json
{
  "name": "RegSymp",
  "url": "https://www.regsymp.com",
  "email": "info@regsymp.com",
  "linkedin": "https://www.linkedin.com/company/regsymp/",
  "twitter": "https://x.com/RegSymp",
  "legalName": "RegSymp Group Limited",
  "themeColor": "#0D1322",
  "defaultOgImage": "/og-image-palma-2026.jpg"
}
```

- [ ] **Step 2: Write the failing test**

Add to `tests/build.test.js`:

```js
test("every page has a canonical URL and OG tags", async () => {
  await buildSite();
  const html = await readOutput("index.html");
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.regsymp\.com\/"/);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta property="og:image"/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the placeholder homepage has no canonical tag.

- [ ] **Step 4: Create `src/_includes/layouts/base.njk`**

```njk
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="{% if noindex %}noindex, nofollow{% else %}index, follow{% endif %}" />
<meta name="author" content="{{ site.name }}" />
<meta name="theme-color" content="{{ site.themeColor }}" />
<title>{{ title }}</title>
<meta name="description" content="{{ description }}" />

<link rel="canonical" href="{{ site.url }}{{ page.url }}" />

<meta property="og:type" content="website" />
<meta property="og:title" content="{{ ogTitle or title }}" />
<meta property="og:description" content="{{ ogDescription or description }}" />
<meta property="og:url" content="{{ site.url }}{{ page.url }}" />
<meta property="og:image" content="{{ site.url }}{{ ogImage or site.defaultOgImage }}" />
<meta property="og:site_name" content="{{ site.name }}" />
<meta property="og:locale" content="en_GB" />

<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="{{ ogTitle or title }}" />
<meta name="twitter:description" content="{{ ogDescription or description }}" />
<meta name="twitter:image" content="{{ site.url }}{{ ogImage or site.defaultOgImage }}" />

<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/css/styles.css" />
{% block head %}{% endblock %}
</head>
<body>
<a href="#home" class="skip-link">Skip to main content</a>
{{ content | safe }}
<script src="/assets/js/site.js" defer></script>
</body>
</html>
```

Note the three `http-equiv` no-cache meta tags from the old `index.html` are deliberately **not** carried over. Caching is handled by `vercel.json` in Task 15.

- [ ] **Step 5: Point the homepage at the layout**

Replace `src/index.njk` entirely:

```njk
---
layout: layouts/base.njk
permalink: /
title: RegSymp | Invite-Only Finance & Fintech Symposium | Palma de Mallorca 2026
description: Invite-only symposium for senior leaders in banking, payments, fintech, wealth, digital assets and AI. Palma de Mallorca, 14–15 September 2026.
ogTitle: RegSymp — Where Finance's Future Is Decided
ogDescription: An invite-only, practitioner-led symposium for senior leaders in banking, payments, fintech, wealth, digital assets and AI. Palma de Mallorca, 14–15 September 2026. Limited to 99 delegates.
---
<main id="home"><h1>RegSymp</h1></main>
```

- [ ] **Step 6: Copy the stylesheet into place**

```bash
mkdir -p src/assets/css src/assets/js
git mv styles.css src/assets/css/styles.css
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Add site data and shared base layout with canonical and OG tags"
```

---

### Task 3: Nav, drawer and footer partials

Collapses markup currently duplicated across six pages into three partials. This is the change that stops the copies drifting.

**Files:**
- Create: `src/_includes/partials/nav.njk`
- Create: `src/_includes/partials/drawer.njk`
- Create: `src/_includes/partials/footer.njk`
- Modify: `src/_includes/layouts/base.njk`
- Modify: `tests/build.test.js`

**Interfaces:**
- Consumes: `site` global from Task 2.
- Produces: three partials included automatically by `base.njk`, so every page gets identical navigation. No page-level opt-in required.

- [ ] **Step 1: Write the failing test**

```js
test("every page gets nav, drawer and footer", async () => {
  await buildSite();
  for (const p of ["index.html", "faq/index.html", "legal/index.html"]) {
    const html = await readOutput(p);
    assert.match(html, /class="nav"/, `${p} missing nav`);
    assert.match(html, /id="drawer"/, `${p} missing mobile drawer`);
    assert.match(html, /class="footer"/, `${p} missing footer`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — no nav partial exists, and `faq/` and `legal/` are not built yet. Those two pages arrive in Tasks 9 and 11; until then this test fails on the missing files, which is correct.

- [ ] **Step 3: Create `src/_includes/partials/nav.njk`**

Port the markup from the current `index.html:181-212`. Nav links are driven by data so all pages agree:

```njk
<header class="nav" id="nav" aria-label="Primary navigation">
  <div class="container nav-inner">
    <a href="/" class="brand brand-hex" aria-label="RegSymp home">
      <img src="/assets/images/regsymp-hex.png" alt="RegSymp" />
    </a>
    {% include "partials/city-select.njk" %}
    <nav class="nav-links" aria-label="Sections">
      <a href="/#about">About</a>
      <a href="/#agenda">Agenda</a>
      <a href="/speakers">Speakers</a>
      <a href="/partners">Partners</a>
    </nav>
    <div class="nav-cta">
      <a href="mailto:{{ site.email }}" class="nav-intro-link" data-invite-trigger>Request an Invitation</a>
      <button class="nav-burger" id="burger" aria-label="Open menu" aria-controls="drawer" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
  </div>
</header>
```

The `data-invite-trigger` attribute is what `site.js` uses in Task 13 to upgrade the link into the modal. The `href` stays a real `mailto:` so the link works if JS fails.

`partials/city-select.njk` is created in Task 10. Until then, create it as an empty file so the build does not error:

```bash
touch src/_includes/partials/city-select.njk
```

- [ ] **Step 4: Create `src/_includes/partials/drawer.njk`**

Port from `index.html:215-231`. Note `aria-expanded` is now on the burger button, and the close button uses `×` consistently (the old `speakers.html` and `partners.html` used `✕`).

```njk
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="drawer-head">
    <span class="brand-wordmark"><img src="/assets/images/regsymp-wordmark-tight.png" alt="RegSymp" /></span>
    <button class="drawer-close" id="drawerClose" aria-label="Close menu">×</button>
  </div>
  <nav class="drawer-links" aria-label="Mobile sections">
    <a href="/#about">About the Event</a>
    <a href="/#agenda">Agenda</a>
    <a href="/speakers">Speakers</a>
    <a href="/partners">Partners</a>
    <a href="/pillars">The Pillars</a>
    <a href="/faq">FAQ</a>
    <a href="mailto:{{ site.email }}" class="drawer-intro-link" data-invite-trigger>Request an Invitation</a>
  </nav>
</aside>
```

- [ ] **Step 5: Create `src/_includes/partials/footer.njk`**

Port from `index.html:441-500`. Two fixes applied: the FAQ link loses `target="_blank"`, and `legal` gains the footer it never had.

```njk
<footer class="footer">
  <div class="container">
    <div class="footer-top">
      <div class="footer-brand">
        <a href="/" class="brand brand-hex" style="color:var(--white); display:inline-flex; align-items:center; gap:0;">
          <img src="/assets/images/regsymp-hex-tight.png" alt="RegSymp" style="height:54px; width:auto; display:block; filter:brightness(0) invert(1);" />
        </a>
        <div class="footer-social">
          <a href="{{ site.linkedin }}" target="_blank" rel="noopener" aria-label="LinkedIn">{% include "partials/icon-linkedin.njk" %}</a>
          <a href="{{ site.twitter }}" target="_blank" rel="noopener" aria-label="X / Twitter">{% include "partials/icon-x.njk" %}</a>
          <a href="mailto:{{ site.email }}" aria-label="Email">{% include "partials/icon-mail.njk" %}</a>
        </div>
      </div>
      <nav class="footer-nav" aria-label="Footer">
        <div><h5>Programme</h5><ul>
          <li><a href="/#about">About</a></li>
          <li><a href="/speakers">Speakers</a></li>
          <li><a href="/#agenda">Agenda</a></li>
          <li><a href="/faq">FAQ</a></li>
        </ul></div>
        <div><h5>Attend</h5><ul>
          <li><a href="mailto:{{ site.email }}" data-invite-trigger>Request an Invite</a></li>
          <li><a href="/#dinner">The Thirty-Three</a></li>
        </ul></div>
        <div><h5>Partner</h5><ul>
          <li><a href="/partners">Partners</a></li>
          <li><a href="/pillars">The Pillars</a></li>
        </ul></div>
        <div class="footer-email"><h5>Contact</h5><ul>
          <li><span class="em-label">General</span><a href="mailto:{{ site.email }}">{{ site.email }}</a></li>
        </ul></div>
      </nav>
    </div>
    <div class="footer-bot">
      <div class="links"><a href="/legal">Legal</a></div>
      <div>© 2026 {{ site.legalName }}. All rights reserved.</div>
    </div>
  </div>
</footer>
```

Create the three icon partials by copying the inline `<svg>` elements from `index.html:449-451` into `src/_includes/partials/icon-linkedin.njk`, `icon-x.njk` and `icon-mail.njk`.

- [ ] **Step 6: Wire the partials into `base.njk`**

In `src/_includes/layouts/base.njk`, replace the line `{{ content | safe }}` with:

```njk
{% include "partials/nav.njk" %}
{% include "partials/drawer.njk" %}
{{ content | safe }}
{% include "partials/footer.njk" %}
{% include "partials/invite-modal.njk" %}
```

Create `src/_includes/partials/invite-modal.njk` as an empty file for now; Task 12 fills it.

- [ ] **Step 7: Run the test**

Run: `npm test`
Expected: the nav/drawer/footer assertions pass for `index.html`. Assertions for `faq/` and `legal/` still fail because those pages do not exist yet — that is expected and resolved in Tasks 9 and 11.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Extract nav, drawer and footer into shared partials"
```

---

### Task 4: Image pipeline

Wires up build-time image optimisation. This is the task that takes the homepage from 5.0 MB toward under 600 KB, and it also emits `width`/`height` on every image, fixing layout shift across the whole site.

**Files:**
- Modify: `.eleventy.js`
- Create: `tests/images.test.js`
- Move: `assets/` → `src/assets/images/`

**Interfaces:**
- Consumes: the Eleventy config from Task 1.
- Produces: any `<img src="/assets/images/...">` in any template is rewritten at build into a `<picture>`-style responsive image with `srcset`, `width`, `height`. Templates keep writing ordinary `<img>` tags — no special syntax.

- [ ] **Step 1: Move image sources into `src/`**

```bash
mkdir -p src/assets/images
git mv assets/Speakers src/assets/images/speakers
git mv assets/Carousel src/assets/images/carousel
git mv assets/*.png assets/*.jpg assets/*.svg src/assets/images/
git rm -r --cached assets 2>/dev/null || true
```

Rename the two non-ASCII speaker filenames to match the `slug` convention used everywhere else, avoiding the encoding problems that produced a mangled duplicate in the working tree:

```bash
git mv "src/assets/images/speakers/Martín L. Aleñar Feliu..jpg" src/assets/images/speakers/martin-alenar.jpg
git mv "src/assets/images/speakers/Alberto Bank of Spain.jpeg" src/assets/images/speakers/alberto-casillas.jpg
git mv "src/assets/images/speakers/Alicia Sanchez.jpeg" src/assets/images/speakers/alicia-sanchez.jpg
git mv "src/assets/images/speakers/Emma Lovett.jpg" src/assets/images/speakers/emma-lovett.jpg
git mv "src/assets/images/speakers/Leago Papo.jpg" src/assets/images/speakers/leago-papo.jpg
git mv "src/assets/images/speakers/Raimundo Alvarino.jpg" src/assets/images/speakers/raimundo-alvarino.jpg
git mv "src/assets/images/speakers/Robby Yung.JPG" src/assets/images/speakers/robby-yung.jpg
git mv "src/assets/images/speakers/Uddin.JPG" src/assets/images/speakers/uddin.jpg
```

- [ ] **Step 2: Write the failing test `tests/images.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";

test("images get dimensions and srcset", async () => {
  await buildSite();
  const html = await readOutput("index.html");
  const imgs = html.match(/<img[^>]*>/g) ?? [];
  assert.ok(imgs.length > 0, "no images on the homepage");
  for (const img of imgs) {
    assert.match(img, /width="\d+"/, `missing width: ${img}`);
    assert.match(img, /height="\d+"/, `missing height: ${img}`);
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — images have no `width` attribute. This is the current site-wide defect: 47 of 47 images lack dimensions.

- [ ] **Step 4: Add the transform plugin to `.eleventy.js`**

Add these imports and the plugin registration inside the exported function:

```js
import { eleventyImageTransformPlugin } from "@11ty/eleventy-img";

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(eleventyImageTransformPlugin, {
    extensions: "html",
    formats: ["webp", "auto"],
    widths: [400, 800, 1200, 1800, 2400],
    failOnError: true,
    defaultAttributes: {
      loading: "lazy",
      decoding: "async",
      sizes: "100vw"
    }
  });

  eleventyConfig.addPassthroughCopy({ "src/assets/css": "assets/css" });
  eleventyConfig.addPassthroughCopy({ "src/assets/js": "assets/js" });
  eleventyConfig.addPassthroughCopy({ "src/assets/images/*.svg": "assets/images" });

  return {
    dir: { input: "src", output: "_site", includes: "_includes", data: "_data" },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
```

`failOnError: true` is the setting that makes a missing or unreadable image break the build rather than silently render a placeholder.

`widths` includes sizes larger than some sources. eleventy-img never upscales — it caps at the source's native width — so the six 832×1248 images will top out at 832 and simply be served as small, well-compressed WebP.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Verify the weight reduction**

```bash
du -sh _site/assets/images | cat
```

Expected: dramatically smaller than the 44 MB of sources. Record the number; Task 16 compares it against the live site.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add build-time responsive image pipeline"
```

---

### Task 5: Homepage content, themes and agenda from data

**Files:**
- Create: `src/_data/themes.json`
- Create: `src/_data/agenda.json`
- Modify: `src/index.njk`
- Create: `tests/homepage.test.js`

**Interfaces:**
- Consumes: `base.njk`, the partials, the image pipeline.
- Produces: `themes` (array of `{num, title, description}`) and `agenda` (object keyed by edition, each with `day1`/`day2` arrays of `{time, title, badge, break}`). Task 10 reuses `agenda` for the other editions.

- [ ] **Step 1: Create `src/_data/themes.json`**

Copy the five themes verbatim from `index.html:281-287`:

```json
[
  { "num": "01", "title": "The Future of Finance", "description": "Which countries will lead the next era of financial innovation across banking, payments, AI and digital assets?" },
  { "num": "02", "title": "Payments, Stablecoins & Programmable Money", "description": "How embedded finance, stablecoins, tokenisation and next-generation payment infrastructure are reshaping the movement of money." },
  { "num": "03", "title": "AI, Wealth & The Reinvention of Banking", "description": "Exploring whether AI will transform — or replace — traditional banking, wealth management and private banking models." },
  { "num": "04", "title": "Trust, Infrastructure & Institutional Resilience", "description": "The operational backbone behind modern finance: custody, safeguarding, operational resilience, cybersecurity and scalable infrastructure." },
  { "num": "05", "title": "The New Financial Ecosystem", "description": "How banks, fintechs, family offices, digital asset firms, investors and technology leaders are converging to build the next generation of financial services." }
]
```

- [ ] **Step 2: Create `src/_data/agenda.json`**

Copy both day arrays verbatim from the `AGENDA.palma` object at `index.html:530-560`, keyed by edition:

```json
{
  "palma": {
    "day1": [
      { "time": "08:30", "title": "Breakfast", "badge": "Lounge", "break": true },
      { "time": "09:30", "title": "Opening Keynote: The Future of Financial Services — Innovation, Trust & Transformation", "badge": "Opening Keynote" }
    ],
    "day2": []
  }
}
```

Transcribe **all 26 rows** from the source — 13 in `day1`, 13 in `day2`. The two shown above are the first two of day 1; do not stop there.

- [ ] **Step 3: Write the failing test `tests/homepage.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";

test("agenda renders all rows server-side", async () => {
  await buildSite();
  const html = await readOutput("index.html");
  const rows = html.match(/class="agenda-row/g) ?? [];
  assert.equal(rows.length, 26, "expected 26 agenda rows in the HTML");
});

test("five programme themes render", async () => {
  const html = await readOutput("index.html");
  const themes = html.match(/class="theme-row"/g) ?? [];
  assert.equal(themes.length, 5);
});
```

The agenda is currently injected by JavaScript, so it is invisible to search engines and to anyone whose scripts fail. Rendering it server-side is a real improvement, and this test locks it in.

- [ ] **Step 4: Run to verify it fails**

Run: `npm test`
Expected: FAIL — homepage is still a placeholder `<h1>`.

- [ ] **Step 5: Build the homepage template**

Port every section from the current `index.html:236-457` into `src/index.njk`, in order: hero, themes, about + gallery, format blocks, why-attend, the setting, agenda, the thirty-three, signup. Two changes while porting:

Render the themes list from data:

```njk
<ol class="themes-list" aria-label="Programme themes">
  {% for t in themes %}
  <li class="theme-row"><span class="num">{{ t.num }}</span>
    <div><h3 class="theme-title">{{ t.title }}</h3><p>{{ t.description }}</p></div>
  </li>
  {% endfor %}
</ol>
```

Render both agenda days from data, replacing the empty `<div class="tab-panel">` elements the old JS filled in:

```njk
{% for dayKey in ["day1", "day2"] %}
<div class="tab-panel{% if loop.first %} active{% endif %}" id="tab-{{ dayKey }}" role="tabpanel"
     aria-labelledby="tab-btn-{{ dayKey }}">
  {% for row in agenda.palma[dayKey] %}
  <div class="agenda-row{% if row.break %} break{% endif %}">
    <div class="time">{{ row.time }}</div>
    <div><div class="title">{{ row.title }}</div></div>
    <div class="spk-meta"><span class="badge">{{ row.badge }}</span></div>
  </div>
  {% endfor %}
</div>
{% endfor %}
```

Add the accessible tab buttons that the panels reference:

```njk
<div class="tabs" role="tablist" aria-label="Programme tabs">
  <button class="tab active" role="tab" id="tab-btn-day1" aria-controls="tab-day1" aria-selected="true">Day 1</button>
  <button class="tab" role="tab" id="tab-btn-day2" aria-controls="tab-day2" aria-selected="false">Day 2</button>
</div>
```

Add the visually hidden descriptive `<h1>` immediately inside `<main id="home">`, keeping the display line as-is:

```njk
<h1 class="visually-hidden">RegSymp — an invite-only finance and fintech symposium for 99 senior leaders, Palma de Mallorca, 14–15 September 2026</h1>
```

Then demote the existing `<h1 class="h-display">The Ninety Nine.</h1>` to a `<p class="h-display">` so there is exactly one `h1`.

- [ ] **Step 6: Add the `visually-hidden` utility to the stylesheet**

Append to `src/assets/css/styles.css`:

```css
.visually-hidden {
  position: absolute; width: 1px; height: 1px;
  padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Render homepage themes and agenda from data server-side"
```

---

### Task 6: Speakers page and Person structured data

**Files:**
- Create: `src/_data/speakers.json`
- Create: `src/_includes/partials/speaker-card.njk`
- Create: `src/speakers.njk`
- Create: `tests/speakers.test.js`

**Interfaces:**
- Consumes: image pipeline from Task 4.
- Produces: `speakers` array. Each record: `{slug, name, role, org, orgUrl, photo, bio, linkedin, twitter}`. `photo` is a bare filename resolved against `/assets/images/speakers/`.

- [ ] **Step 1: Create `src/_data/speakers.json`**

Transcribe all 15 speakers from the existing `speakers.html` cards and the `Person` JSON-LD blocks in `index.html:110-165`. First record shown; complete the remaining 14:

```json
[
  {
    "slug": "luis-gelado",
    "name": "Luis Gelado Crespo",
    "role": "Founder",
    "org": "Standard 21",
    "orgUrl": "https://standard21.com",
    "photo": "luis-gelado.jpg",
    "bio": "Founder of Standard 21, Spain's first Bitcoin-native treasury holding company. Serial entrepreneur with a background in blockchain infrastructure and decentralised data.",
    "linkedin": "https://www.linkedin.com/in/luisgelado/",
    "twitter": "https://twitter.com/lgelado"
  }
]
```

- [ ] **Step 2: Write the failing test `tests/speakers.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";
import speakers from "../src/_data/speakers.json" with { type: "json" };

test("every speaker renders a card", async () => {
  await buildSite();
  const html = await readOutput("speakers/index.html");
  for (const s of speakers) {
    assert.ok(html.includes(s.name), `missing card for ${s.name}`);
  }
});

test("Person schema lives on the speakers page, not the homepage", async () => {
  const speakersHtml = await readOutput("speakers/index.html");
  const homeHtml = await readOutput("index.html");
  assert.match(speakersHtml, /"@type":\s*"Person"/);
  assert.doesNotMatch(homeHtml, /"@type":\s*"Person"/);
});

test("Person schema URLs point at the speakers page", async () => {
  const html = await readOutput("speakers/index.html");
  assert.doesNotMatch(html, /regsymp\.com\/#speakers/,
    "schema still points at the dead #speakers anchor");
});
```

The third test encodes a real defect: all `Person` schema currently sits on the homepage with `"url": "https://www.regsymp.com/#speakers"`, an anchor that no longer exists.

- [ ] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `speakers/index.html` does not exist.

- [ ] **Step 4: Create `src/_includes/partials/speaker-card.njk`**

Port the card markup from `speakers.html:459-470`, dropping the inline `onerror` handler — `failOnError` in the image pipeline now catches missing photos at build time instead.

```njk
<article class="speaker-page-card">
  <div class="speaker-page-card__photo-wrap">
    <img class="speaker-page-card__photo"
         src="/assets/images/speakers/{{ speaker.photo }}"
         alt="{{ speaker.name }}" />
  </div>
  <div class="speaker-page-card__body">
    <p class="speaker-page-card__name">{{ speaker.name }}</p>
    <p class="speaker-page-card__role">{{ speaker.role }}{% if speaker.org %}, {{ speaker.org }}{% endif %}</p>
    <p class="speaker-page-card__bio">{{ speaker.bio }}</p>
    {% if speaker.linkedin %}
    <a class="speaker-card__link" href="{{ speaker.linkedin }}" target="_blank" rel="noopener">LinkedIn</a>
    {% endif %}
  </div>
</article>
```

- [ ] **Step 5: Create `src/speakers.njk`**

```njk
---
layout: layouts/base.njk
permalink: /speakers/
title: Speakers — RegSymp
description: Meet the confirmed speakers for RegSymp 2026 — senior practitioners from banking, payments, digital assets, AI and wealth management.
---
<main>
  <section class="section dark">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow on-dark">The Faculty</span>
        <h1 class="h2">Speakers.</h1>
      </div>
      <div class="speaker-grid">
        {% for speaker in speakers %}{% include "partials/speaker-card.njk" %}{% endfor %}
      </div>
    </div>
  </section>
</main>

{% for speaker in speakers %}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": {{ speaker.name | dump | safe }},
  "jobTitle": {{ speaker.role | dump | safe }},
  {% if speaker.org %}"worksFor": { "@type": "Organization", "name": {{ speaker.org | dump | safe }}{% if speaker.orgUrl %}, "url": {{ speaker.orgUrl | dump | safe }}{% endif %} },{% endif %}
  "description": {{ speaker.bio | dump | safe }},
  "url": "{{ site.url }}/speakers/"
}
</script>
{% endfor %}
```

The `dump` filter JSON-escapes values, which matters because several names and bios contain characters that would otherwise break the JSON-LD.

- [ ] **Step 6: Run to verify it passes**

Run: `npm test`
Expected: PASS, including the assertion that the homepage no longer carries `Person` schema.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Generate speakers page and Person schema from data"
```

---

### Task 7: FAQ page and FAQPage schema from one source

Closes the drift risk between the visible FAQ and its structured data, which are currently two independent copies.

**Files:**
- Create: `src/_data/faq.json`
- Create: `src/faq.njk`
- Create: `tests/faq.test.js`

**Interfaces:**
- Consumes: `base.njk`, partials.
- Produces: `faq` array of `{question, answer}`.

- [ ] **Step 1: Create `src/_data/faq.json`**

Transcribe all nine entries from the `FAQPage` JSON-LD at `index.html:88-100`, cross-checking each against the visible text in `faq.html`. Where the two disagree, the visible page wins — note any disagreement in the commit message.

```json
[
  { "question": "When and where is RegSymp held?", "answer": "RegSymp takes place in Palma de Mallorca, Spain on 14–15 September 2026." }
]
```

- [ ] **Step 2: Write the failing test `tests/faq.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";
import faq from "../src/_data/faq.json" with { type: "json" };

test("visible FAQ and FAQPage schema cannot disagree", async () => {
  await buildSite();
  const html = await readOutput("faq/index.html");
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, "no JSON-LD on the FAQ page");
  const data = JSON.parse(block[1]);
  assert.equal(data.mainEntity.length, faq.length);
  for (const entry of faq) {
    assert.ok(html.includes(entry.question), `question missing from visible page: ${entry.question}`);
    assert.ok(
      data.mainEntity.some((q) => q.name === entry.question),
      `question missing from schema: ${entry.question}`
    );
  }
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL — no FAQ page yet.

- [ ] **Step 4: Create `src/faq.njk`**

```njk
---
layout: layouts/base.njk
permalink: /faq/
title: FAQ — RegSymp | Palma de Mallorca 2026
description: Frequently asked questions about RegSymp, the invite-only finance and fintech symposium. Palma de Mallorca, 14–15 September 2026.
---
<main>
  <section class="section dark" style="padding-top: clamp(100px, 12vw, 160px);">
    <div class="container">
      <div class="section-head">
        <span class="eyebrow on-dark">Questions</span>
        <h1 class="h2">Frequently asked.</h1>
      </div>
      <div class="faq-list">
        {% for item in faq %}
        <details class="faq-item">
          <summary>{{ item.question }}</summary>
          <p>{{ item.answer }}</p>
        </details>
        {% endfor %}
      </div>
    </div>
  </section>
</main>

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {% for item in faq %}
    { "@type": "Question", "name": {{ item.question | dump | safe }},
      "acceptedAnswer": { "@type": "Answer", "text": {{ item.answer | dump | safe }} } }{% if not loop.last %},{% endif %}
    {% endfor %}
  ]
}
</script>
```

- [ ] **Step 5: Remove the duplicate FAQ schema from the homepage**

Delete the `FAQPage` JSON-LD block that Task 5 carried over into `src/index.njk`, if present. The schema now belongs solely to `/faq`.

- [ ] **Step 6: Run to verify it passes**

Run: `npm test`
Expected: PASS. The FAQ page now also has a mobile drawer, inherited from `base.njk` — the defect where it had no mobile navigation at all is fixed by construction.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Generate FAQ page and FAQPage schema from a single data source"
```

---

### Task 8: Partners, Pillars and Legal pages

**Files:**
- Create: `src/_data/partners.json`
- Create: `src/partners.njk`
- Create: `src/pillars.njk`
- Create: `src/legal.njk`

**Interfaces:**
- Consumes: `base.njk`, partials.
- Produces: `partners` array of `{name, logo, url, tier}`.

- [ ] **Step 1: Create `src/_data/partners.json`**

Transcribe from the existing `partners.html` partner grid.

- [ ] **Step 2: Port `partners.njk` and `pillars.njk`**

Move the `<main>` content from the current `partners.html` and `pillars.html` into templates with front matter. Move any page-scoped `<style>` blocks (both pages have one) into `styles.css` under a clearly commented section, since inline `<style>` per page defeats caching.

Set `permalink: /partners/` and `permalink: /pillars/`. Keep `pillars.njk`'s existing description and OG values from `pillars.html:1-25`.

- [ ] **Step 3: Port `legal.njk` with the privacy wording corrected**

Move the content from `legal.html`. It now inherits nav and footer from `base.njk`, fixing the dead-end page.

Replace the cookies paragraph at `legal.html:265`. The current text claims analytics that do not exist:

> The RegSymp website uses a small number of first-party cookies for basic site analytics and to remember non-personal preferences such as accepted notices. No advertising cookies are set.

with wording that matches reality and covers the new form:

> The RegSymp website sets no analytics or advertising cookies. A single browser storage entry records which city edition you last viewed, so the site can return you to it; this is not shared and identifies no one. If you submit an invitation request, we process the name, email address, company, role and any message you provide solely to assess and respond to that request. We keep it for as long as needed for that purpose and do not share it with third parties. To have it removed, write to info@regsymp.com.

- [ ] **Step 4: Verify the build**

Run: `npm test`
Expected: PASS, including the Task 3 test asserting nav/drawer/footer on `legal/index.html`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Port partners, pillars and legal pages; correct privacy policy wording"
```

---

### Task 9: Editions and the city selector

Turns the dormant single-city dropdown into a working navigator across three published editions, and stops it overwriting the SEO title.

**Files:**
- Create: `src/_data/editions.json`
- Create: `src/_includes/partials/city-select.njk` (replaces the empty placeholder)
- Create: `src/london-2027.njk`
- Create: `src/luxembourg-2027.njk`
- Create: `tests/editions.test.js`

**Interfaces:**
- Consumes: `agenda` from Task 5.
- Produces: `editions` array of `{key, label, url, current}`. `site.js` (Task 13) reads `data-edition-url` from the menu items to navigate.

- [ ] **Step 1: Create `src/_data/editions.json`**

```json
[
  { "key": "palma",      "label": "Palma de Mallorca 2026", "url": "/" },
  { "key": "london",     "label": "London 2027",            "url": "/london-2027/" },
  { "key": "luxembourg", "label": "Luxembourg 2027",        "url": "/luxembourg-2027/" }
]
```

- [ ] **Step 2: Write the failing test `tests/editions.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";

test("all three editions are reachable and cross-linked", async () => {
  await buildSite();
  for (const p of ["index.html", "london-2027/index.html", "luxembourg-2027/index.html"]) {
    const html = await readOutput(p);
    assert.match(html, /data-edition-url="\/london-2027\/"/, `${p} missing London link`);
    assert.match(html, /data-edition-url="\/luxembourg-2027\/"/, `${p} missing Luxembourg link`);
  }
});

test("edition pages have their own OG image", async () => {
  const html = await readOutput("london-2027/index.html");
  assert.match(html, /og:image" content="[^"]*og-image-london-2027/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test`
Expected: FAIL — edition pages do not exist.

- [ ] **Step 4: Create `src/_includes/partials/city-select.njk`**

```njk
<div class="city-pick" id="cityPick" style="margin-right:auto;">
  <button class="city-pick-btn" id="cityPickBtn" aria-expanded="false" aria-haspopup="listbox" aria-label="Select city edition">
    <span id="cityPickLabel">{{ edition.label if edition else editions[0].label }}</span>
    <svg class="chev" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
  <div class="city-menu" role="listbox" aria-label="City editions">
    {% for e in editions %}
    <div class="city-menu-item" role="option" tabindex="0"
         data-edition-url="{{ e.url }}"
         aria-selected="{{ 'true' if edition and e.key == edition.key else 'false' }}">
      <span>{{ e.label }}</span>
    </div>
    {% endfor %}
  </div>
</div>
```

Each page sets `edition` in its front matter (e.g. `edition: { key: palma, label: "Palma de Mallorca 2026" }`) so the button shows the current edition and `aria-selected` is correct.

- [ ] **Step 5: Create the two edition pages**

Port `RegSymp London 2027.html` and `RegSymp Luxembourg 2027.html` into `src/london-2027.njk` and `src/luxembourg-2027.njk`, with `permalink: /london-2027/` and `/luxembourg-2027/`. Set `ogImage: /og-image-london-2027.jpg` and `/og-image-luxembourg-2027.jpg`. Delete the old space-containing files.

- [ ] **Step 6: Create the two missing OG images**

Both pages reference OG images that do not exist, so they currently share as blank cards. Generate 1200×630 JPEGs matching the existing `og-image-palma-2026.jpg` treatment, saved to `src/assets/images/og-image-london-2027.jpg` and `og-image-luxembourg-2027.jpg`.

Verify: `node -e "import('sharp')"` is not needed — check dimensions with any image tool and confirm both are exactly 1200×630, matching the Palma card.

- [ ] **Step 7: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Publish London and Luxembourg editions with a working city selector"
```

---

### Task 10: Consolidated site.js and accessibility fixes

Replaces the JS duplicated across four pages with one module, and fixes the accessibility defects in the process.

**Files:**
- Create: `src/assets/js/site.js`
- Create: `src/assets/js/focus-trap.js`
- Modify: `src/assets/css/styles.css`

**Interfaces:**
- Consumes: DOM produced by the partials — `#nav`, `#burger`, `#drawer`, `#drawerClose`, `#cityPick`, `.tab[role=tab]`, `[data-gallery-prev]`, `[data-gallery-next]`, `.reveal`.
- Produces: `trapFocus(container)` from `focus-trap.js`, returning a `release()` function. Task 12's modal reuses it.

- [ ] **Step 1: Create `src/assets/js/focus-trap.js`**

```js
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapFocus(container) {
  const previouslyFocused = document.activeElement;
  const nodes = () => [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);

  function onKeydown(e) {
    if (e.key !== "Tab") return;
    const items = nodes();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", onKeydown);
  nodes()[0]?.focus();

  return function release() {
    container.removeEventListener("keydown", onKeydown);
    previouslyFocused?.focus();
  };
}
```

- [ ] **Step 2: Create `src/assets/js/site.js`**

Port the behaviour from `index.html:504-730`, with these changes:

- **Delete the agenda rendering entirely.** Task 5 renders it server-side.
- **Delete the `document.title` override.** It currently replaces the SEO title with a shorter one that drops "invite-only", "fintech" and "symposium".
- **Delete the `?city=` URL parameter and `history.pushState` machinery.** Editions are separate pages now.
- **Keep** the `localStorage` edition memory only if it does something useful; otherwise drop it. Prefer dropping it — the privacy wording in Task 8 mentions one storage entry, so if dropped, remove that sentence too.
- Drawer uses `trapFocus`, closes on Escape, and keeps `aria-expanded` on the burger in sync.
- Tabs get arrow-key navigation and toggle `aria-selected` plus the panels' visibility.

```js
import { trapFocus } from "./focus-trap.js";

(function () {
  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 60);
    document.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // Drawer
  const burger = document.getElementById("burger");
  const drawer = document.getElementById("drawer");
  const drawerClose = document.getElementById("drawerClose");
  let releaseDrawer = null;

  function setDrawer(open) {
    if (!drawer) return;
    drawer.classList.toggle("open", open);
    drawer.setAttribute("aria-hidden", String(!open));
    burger?.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
    if (open) {
      releaseDrawer = trapFocus(drawer);
    } else {
      releaseDrawer?.();
      releaseDrawer = null;
    }
  }

  burger?.addEventListener("click", () => setDrawer(true));
  drawerClose?.addEventListener("click", () => setDrawer(false));
  drawer?.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setDrawer(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer?.classList.contains("open")) setDrawer(false);
  });

  // City selector — navigates between edition pages
  const cityPick = document.getElementById("cityPick");
  const cityBtn = document.getElementById("cityPickBtn");
  cityBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = cityPick.classList.toggle("open");
    cityBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", () => {
    cityPick?.classList.remove("open");
    cityBtn?.setAttribute("aria-expanded", "false");
  });
  document.querySelectorAll(".city-menu-item[data-edition-url]").forEach((item) => {
    const go = () => { window.location.href = item.dataset.editionUrl; };
    item.addEventListener("click", (e) => { e.stopPropagation(); go(); });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  });

  // Agenda tabs
  const tabs = [...document.querySelectorAll(".tab[role=tab]")];
  function selectTab(tab) {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.classList.toggle("active", selected);
      t.setAttribute("aria-selected", String(selected));
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      panel?.classList.toggle("active", selected);
    });
    tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") selectTab(tabs[(i + 1) % tabs.length]);
      if (e.key === "ArrowLeft") selectTab(tabs[(i - 1 + tabs.length) % tabs.length]);
    });
  });

  // Gallery arrows
  document.querySelectorAll("[data-gallery-prev], [data-gallery-next]").forEach((btn) => {
    const trackId = btn.dataset.galleryPrev || btn.dataset.galleryNext;
    const track = document.getElementById(trackId);
    if (!track) return;
    const dir = btn.hasAttribute("data-gallery-prev") ? -1 : 1;
    btn.addEventListener("click", () => {
      const item = track.querySelector(".gallery-item");
      if (!item) return;
      const gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap || "0");
      track.scrollBy({ left: (item.getBoundingClientRect().width + gap) * dir, behavior: "smooth" });
    });
  });

  // Reveal on scroll
  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }),
    { threshold: 0.08, rootMargin: "0px 0px -80px 0px" }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
})();
```

Because `site.js` now uses `import`, change the script tag in `base.njk` to `type="module"`:

```njk
<script type="module" src="/assets/js/site.js"></script>
```

`type="module"` is deferred by default, so drop the `defer` attribute.

- [ ] **Step 3: Fix the focus outline contrast**

In `src/assets/css/styles.css`, the `:focus-visible` rule uses `#8B9BB4`, which measures 2.8:1 against white — below the 3:1 minimum for non-text contrast. Change it:

```css
:focus-visible {
  outline: 3px solid #4A5D7E;
  outline-offset: 3px;
  border-radius: 3px;
}
```

Verify `#4A5D7E` on `#FFFFFF` measures at least 3:1 with any contrast checker before committing.

- [ ] **Step 4: Set decorative backgrounds to empty alt**

In `src/index.njk`, change `alt` to `""` on the three full-bleed decorative backgrounds (`sailboat-mallorca`, `the-setting-palma`, `thirty-three-dinner`) so screen readers stop narrating scenery mid-content.

- [ ] **Step 5: Verify in a browser**

Run: `npm run serve`, open `http://localhost:8091`, then check:
- Tab to the burger on a narrow window, open the drawer, confirm Tab cycles inside it and Escape closes it and returns focus to the burger.
- On the agenda, focus a tab and press Left/Right arrows.
- Confirm the focus ring is clearly visible on white sections.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Consolidate site JavaScript and fix accessibility defects"
```

---

### Task 11: Homepage closing section reframed as newsletter

**Files:**
- Modify: `src/index.njk`

- [ ] **Step 1: Rewrite the `#signup` section**

The section currently headed "Request an Invitation." renders a beehiiv **newsletter** form. Keep the newsletter; fix the framing.

```njk
<section class="section dark-deep" id="signup">
  <div class="container reveal" style="text-align:center; max-width:640px; margin-left:auto; margin-right:auto;">
    <span class="eyebrow on-dark">Stay Close To The Conversation</span>
    <h2 class="h2" style="color:#F6F3EC;">Stay Connected.</h2>
    <p class="lede on-dark" style="margin:0 auto 40px;">Quarterly briefings on the themes shaping RegSymp, news from each edition, and first word when the next one opens.</p>
    <div style="max-width:480px; margin:0 auto;">
      <script async src="https://subscribe-forms.beehiiv.com/v3/loader.js" data-beehiiv-form="4ef0fdb8-3474-4e84-a9de-d46ec2d283fe"></script>
    </div>
  </div>
</section>
```

Only the heading and the lede change. The eyebrow already fits and the embed is unchanged.

- [ ] **Step 2: Verify**

Run: `npm run serve` and confirm the section reads as a newsletter block and the beehiiv form still renders.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Reframe homepage closing section as a newsletter block"
```

---

### Task 12: Invitation request modal

**Files:**
- Modify: `src/_includes/partials/invite-modal.njk`
- Modify: `src/assets/js/site.js`
- Modify: `src/assets/css/styles.css`
- Create: `tests/modal.test.js`

**Interfaces:**
- Consumes: `trapFocus` from Task 10.
- Produces: markup with `id="inviteModal"`, a `<form id="inviteForm">` posting to `/api/request-invitation`. Fields named `name`, `email`, `company`, `role`, `mobile`, `message`, `consent`, plus honeypot `website` and timestamp `startedAt`.

- [ ] **Step 1: Write the failing test `tests/modal.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite, readOutput } from "./helpers/build.js";

test("invite modal is present on every page with correct fields", async () => {
  await buildSite();
  for (const p of ["index.html", "speakers/index.html", "faq/index.html"]) {
    const html = await readOutput(p);
    assert.match(html, /id="inviteModal"/, `${p} missing modal`);
    for (const field of ["name", "email", "company", "role", "mobile", "message", "consent"]) {
      assert.match(html, new RegExp(`name="${field}"`), `${p} missing field ${field}`);
    }
    assert.match(html, /name="website"/, `${p} missing honeypot`);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
  }
});

test("invite triggers keep a working mailto fallback", async () => {
  const html = await readOutput("index.html");
  const triggers = html.match(/<a[^>]*data-invite-trigger[^>]*>/g) ?? [];
  assert.ok(triggers.length > 0, "no invite triggers found");
  for (const t of triggers) {
    assert.match(t, /href="mailto:/, `trigger has no mailto fallback: ${t}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `invite-modal.njk` is still empty.

- [ ] **Step 3: Fill `src/_includes/partials/invite-modal.njk`**

```njk
<div class="invite-modal" id="inviteModal" role="dialog" aria-modal="true"
     aria-labelledby="inviteModalTitle" hidden>
  <div class="invite-modal__backdrop" data-invite-close></div>
  <div class="invite-modal__panel">
    <button type="button" class="invite-modal__close" data-invite-close aria-label="Close">×</button>
    <span class="eyebrow on-dark">By Invitation Only</span>
    <h2 class="h3" id="inviteModalTitle">Request an Invitation.</h2>
    <p class="invite-modal__lede">Attendance is curated. Tell us a little about your role and we will be in touch.</p>

    <form id="inviteForm" novalidate>
      <input type="hidden" name="startedAt" id="inviteStartedAt" value="" />
      <div class="invite-hp" aria-hidden="true">
        <label>Website<input type="text" name="website" tabindex="-1" autocomplete="off" /></label>
      </div>

      <label for="inviteName">Name <span aria-hidden="true">*</span></label>
      <input id="inviteName" name="name" type="text" required autocomplete="name" />

      <label for="inviteEmail">Email <span aria-hidden="true">*</span></label>
      <input id="inviteEmail" name="email" type="email" required autocomplete="email" />

      <label for="inviteCompany">Company <span aria-hidden="true">*</span></label>
      <input id="inviteCompany" name="company" type="text" required autocomplete="organization" />

      <label for="inviteRole">Role <span aria-hidden="true">*</span></label>
      <input id="inviteRole" name="role" type="text" required autocomplete="organization-title" />

      <label for="inviteMobile">Mobile</label>
      <input id="inviteMobile" name="mobile" type="tel" autocomplete="tel" />

      <label for="inviteMessage">Anything you would like to add</label>
      <textarea id="inviteMessage" name="message" rows="4"></textarea>

      <label class="invite-consent">
        <input type="checkbox" name="consent" required />
        <span>I agree that RegSymp may store and use these details to assess and respond to my request, as described in the <a href="/legal/#privacy">privacy policy</a>.</span>
      </label>

      <button type="submit" class="invite-submit">Request an Invitation</button>
      <p class="invite-status" id="inviteStatus" role="status" aria-live="polite"></p>
    </form>
  </div>
</div>
```

The honeypot wrapper `.invite-hp` must be hidden with CSS (`position:absolute; left:-9999px;`) rather than `display:none`, since some bots skip `display:none` fields.

- [ ] **Step 4: Add modal styles to `styles.css`**

Style `.invite-modal` to match the existing dark sections — `--navy-deep` panel, `--gold` accents, `--sans` body type. Include `.invite-hp { position:absolute; left:-9999px; width:1px; height:1px; overflow:hidden; }`.

- [ ] **Step 5: Add modal behaviour to `site.js`**

```js
  // Invitation modal
  const modal = document.getElementById("inviteModal");
  const form = document.getElementById("inviteForm");
  const statusEl = document.getElementById("inviteStatus");
  let releaseModal = null;

  function openModal(e) {
    if (!modal) return;
    e?.preventDefault();
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    document.getElementById("inviteStartedAt").value = String(Date.now());
    releaseModal = trapFocus(modal);
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    releaseModal?.();
    releaseModal = null;
  }

  document.querySelectorAll("[data-invite-trigger]").forEach((el) =>
    el.addEventListener("click", openModal)
  );
  document.querySelectorAll("[data-invite-close]").forEach((el) =>
    el.addEventListener("click", closeModal)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const submit = form.querySelector(".invite-submit");
    submit.disabled = true;
    statusEl.textContent = "Sending…";
    try {
      const res = await fetch("/api/request-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form)))
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      form.hidden = true;
      statusEl.textContent = "Thank you. We will be in touch.";
    } catch (err) {
      statusEl.textContent = err.message;
      submit.disabled = false;
    }
  });
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add invitation request modal with mailto fallback"
```

---

### Task 13: Invitation API endpoint

**Files:**
- Create: `api/_lib/validate.js`
- Create: `api/request-invitation.js`
- Create: `tests/validate.test.js`

**Interfaces:**
- Consumes: form fields from Task 12.
- Produces: `validateSubmission(body)` returning `{ ok: true, data }` or `{ ok: false, error }`. Kept in a separate module precisely so it can be unit-tested without network or environment variables.

- [ ] **Step 1: Write the failing test `tests/validate.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSubmission } from "../api/_lib/validate.js";

const valid = {
  name: "Jane Doe", email: "jane@example.com", company: "Example Bank",
  role: "Head of Payments", mobile: "", message: "", consent: "on",
  website: "", startedAt: String(Date.now() - 10_000)
};

test("accepts a complete submission", () => {
  assert.equal(validateSubmission(valid).ok, true);
});

test("rejects a filled honeypot", () => {
  const r = validateSubmission({ ...valid, website: "http://spam.example" });
  assert.equal(r.ok, false);
});

test("rejects submissions faster than three seconds", () => {
  const r = validateSubmission({ ...valid, startedAt: String(Date.now() - 500) });
  assert.equal(r.ok, false);
});

test("requires name, email, company and role", () => {
  for (const field of ["name", "email", "company", "role"]) {
    const r = validateSubmission({ ...valid, [field]: "" });
    assert.equal(r.ok, false, `${field} should be required`);
  }
});

test("mobile and message are optional", () => {
  assert.equal(validateSubmission({ ...valid, mobile: "", message: "" }).ok, true);
});

test("requires consent", () => {
  assert.equal(validateSubmission({ ...valid, consent: "" }).ok, false);
});

test("rejects a malformed email", () => {
  assert.equal(validateSubmission({ ...valid, email: "not-an-email" }).ok, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/validate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `api/_lib/validate.js`**

```js
const REQUIRED = ["name", "email", "company", "role"];
const MAX = { name: 120, email: 200, company: 160, role: 160, mobile: 40, message: 2000 };
const MIN_FILL_MS = 3000;

export function validateSubmission(body = {}) {
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { ok: false, error: "Rejected." };
  }

  const started = Number(body.startedAt);
  if (Number.isFinite(started) && Date.now() - started < MIN_FILL_MS) {
    return { ok: false, error: "Rejected." };
  }

  for (const field of REQUIRED) {
    if (typeof body[field] !== "string" || body[field].trim() === "") {
      return { ok: false, error: `Please provide your ${field}.` };
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return { ok: false, error: "Please provide a valid email address." };
  }

  if (!body.consent) {
    return { ok: false, error: "Please confirm you agree to the privacy policy." };
  }

  const data = {};
  for (const [field, limit] of Object.entries(MAX)) {
    data[field] = String(body[field] ?? "").trim().slice(0, limit);
  }
  return { ok: true, data };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/validate.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Create `api/request-invitation.js`**

```js
import { Resend } from "resend";
import { validateSubmission } from "./_lib/validate.js";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const result = validateSubmission(req.body);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const { name, email, company, role, mobile, message } = result.data;
  const rows = [
    ["Name", name], ["Email", email], ["Company", company],
    ["Role", role], ["Mobile", mobile || "—"], ["Message", message || "—"]
  ];

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM,
      to: process.env.INVITATION_RECIPIENT,
      replyTo: email,
      subject: `Invitation request — ${name}, ${company}`,
      html: `<h2>Invitation request</h2><table>${rows
        .map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${escapeHtml(v)}</td></tr>`)
        .join("")}</table>`
    });
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("invitation send failed:", err);
    return res.status(502).json({ error: "We could not send that. Please email info@regsymp.com." });
  }
}
```

`replyTo` is set to the submitter so replying from the inbox reaches them directly. All interpolated values pass through `escapeHtml`, since they are attacker-controlled.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add invitation request API endpoint backed by Resend"
```

---

### Task 14: sitemap, robots, Vercel config and deletions

**Files:**
- Create: `src/sitemap.njk`
- Create: `src/robots.njk`
- Modify: `vercel.json`
- Delete: `export/`, `uploads/`, `assets/hero.mp4`, `Mallorca palma design.png`, `.DS_Store`, and the eight root `.html` files

- [ ] **Step 1: Create `src/sitemap.njk`**

```njk
---
permalink: /sitemap.xml
eleventyExcludeFromCollections: true
---
<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{% for page in collections.all %}{% if not page.data.noindex %}
  <url><loc>{{ site.url }}{{ page.url }}</loc></url>
{% endif %}{% endfor %}
</urlset>
```

- [ ] **Step 2: Create `src/robots.njk`**

```njk
---
permalink: /robots.txt
eleventyExcludeFromCollections: true
---
User-agent: *
Allow: /

Sitemap: {{ site.url }}/sitemap.xml
```

- [ ] **Step 3: Extend `vercel.json` with build and cache headers**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build",
  "outputDirectory": "_site",
  "cleanUrls": true,
  "trailingSlash": false,
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    },
    {
      "source": "/(.*).html",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }]
    }
  ]
}
```

The one-year immutable cache is only safe because eleventy-img gives every generated file a content hash.

- [ ] **Step 4: Delete superseded files**

```bash
git rm -r export uploads
git rm "assets/hero.mp4" "Mallorca palma design.png" .DS_Store
git rm index.html speakers.html partners.html pillars.html faq.html legal.html
git rm "RegSymp London 2027.html" "RegSymp Luxembourg 2027.html"
```

Keep `RegSymp-Brand-Guidelines.docx` and `RegSymp-Council-Membership.md`.

Removing these from `HEAD` does not shrink the 70 MB `.git`; that is expected and accepted.

- [ ] **Step 5: Verify the full build**

Run: `npm test`
Expected: PASS. Then confirm `_site/sitemap.xml` lists all eight pages and `_site/robots.txt` exists.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add sitemap and robots, configure Vercel build and caching, remove superseded files"
```

---

### Task 15: Verification against the live site

The rebuild claims to look identical. This task proves or disproves that.

**Files:**
- Create: `tests/links.test.js`
- Create: `docs/superpowers/plans/2026-08-25-verification-report.md`

- [ ] **Step 1: Write the link check `tests/links.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSite } from "./helpers/build.js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function htmlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await htmlFiles(full)));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

test("no internal link points at a missing page", async () => {
  await buildSite();
  const files = await htmlFiles("_site");
  const pages = new Set(files.map((f) =>
    "/" + path.relative("_site", f).replace(/\\/g, "/").replace(/index\.html$/, "")
  ));
  const broken = [];
  for (const file of files) {
    const html = await readFile(file, "utf8");
    for (const m of html.matchAll(/href="(\/[^"#?]*)/g)) {
      const target = m[1].endsWith("/") ? m[1] : m[1] + "/";
      if (m[1].startsWith("/assets/")) continue;
      if (!pages.has(target) && !pages.has(m[1])) broken.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `broken internal links:\n${broken.join("\n")}`);
});
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests PASS. Fix any broken links before continuing.

- [ ] **Step 3: Capture before/after page weight**

With `npm run serve` running, for each of the eight pages record total transferred bytes from the browser's network panel, and compare against the same page on `https://regsymp.vercel.app`. Record both figures.

Expected: homepage under 600 KB against the current 5.0 MB.

- [ ] **Step 4: Screenshot comparison**

For each of the eight pages, at viewport widths 375, 768 and 1440, capture the rebuilt page and the live page and compare section by section. Note every difference.

Permitted differences only: the FAQ page now has a mobile drawer; the homepage closing section reads "Stay Connected."; images are sharper or identical, never worse.

Any other visual difference is a defect to fix before merge.

- [ ] **Step 5: Test the form end to end**

With `RESEND_API_KEY`, `RESEND_FROM` and `INVITATION_RECIPIENT` set on a Vercel preview deployment, submit the form and confirm: the email arrives at `info@regsymp.com`; replying reaches the submitter's address; a submission with the honeypot filled is rejected; a submission with a missing role is rejected.

- [ ] **Step 6: Write the verification report**

Record in `docs/superpowers/plans/2026-08-25-verification-report.md`: the weight table, the list of visual differences found and their resolution, and the form test results.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Add link checking and record rebuild verification results"
```

---

## Notes for the implementer

**The build must stay green.** Every task ends with `npm test` passing. If a task leaves a test failing because a later task creates the missing page, the task text says so explicitly — Task 3 is the only such case.

**Do not restyle anything.** `styles.css` is ported unmodified apart from three explicitly listed additions: the `.visually-hidden` utility, the `:focus-visible` colour, and the modal styles.

**Transcribe content exactly.** Where a task says to copy text from an existing file, copy it verbatim, including en dashes, ampersands and British spellings. The site's voice is deliberate.

**Prerequisites outside the repo** — these gate Task 15 Step 5, not the build:
- Vercel project connected to `Chrissou78/Regsymp`
- A Resend account, with `RESEND_API_KEY`, `RESEND_FROM` and `INVITATION_RECIPIENT` set in the Vercel dashboard
- SPF and DKIM records on `regsymp.com` for the Resend sending domain
