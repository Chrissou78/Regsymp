import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PREVIEW_COOKIE,
  enterPreview,
  leavePreview,
  previewBanner,
  previewFrom
} from "../admin/preview.js";

/**
 * Previewing a draft event.
 *
 * It is the site, built from a draft's own speakers and sponsors. The cookie
 * says which event; it does not say who may look. Every request checks for a
 * signed-in administrator separately, and these tests cover the half that can
 * be tested without one: that the cookie is read safely, and that a preview
 * announces itself.
 */

const event = { slug: "london-2026", name: "The 33 · London", whenLabel: "November 2026", status: "draft" };

test("the cookie is read back", () => {
  const set = enterPreview("london-2026");
  assert.match(set, new RegExp(`^${PREVIEW_COOKIE}=london-2026`));
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);
  assert.match(set, /Path=\//);

  const req = { headers: { cookie: set.split(";")[0] } };
  assert.equal(previewFrom(req), "london-2026");
});

test("it is found among other cookies", () => {
  const req = {
    headers: {
      cookie: `regsymp_admin=abc; ${PREVIEW_COOKIE}=davos-2027; regsymp_who=guest-admin`
    }
  };
  assert.equal(previewFrom(req), "davos-2027");
});

test("no cookie is not a preview", () => {
  assert.equal(previewFrom({ headers: {} }), null);
  assert.equal(previewFrom({ headers: { cookie: "" } }), null);
  assert.equal(previewFrom({ headers: { cookie: "regsymp_admin=abc" } }), null);
});

test("anything that is not a slug is refused", () => {
  // It becomes a directory name. A cookie is the visitor's to write, so this
  // is the boundary between a hint and a path.
  for (const nasty of [
    "../../etc/passwd",
    "..",
    "a/b",
    "london 2026",
    "LONDON",
    "london_2026",
    "",
    "-leading",
    "trailing-"
  ]) {
    const req = { headers: { cookie: `${PREVIEW_COOKIE}=${encodeURIComponent(nasty)}` } };
    assert.equal(previewFrom(req), null, `accepted ${JSON.stringify(nasty)}`);
  }
});

test("an encoded traversal is still a traversal", () => {
  const req = { headers: { cookie: `${PREVIEW_COOKIE}=%2e%2e%2f%2e%2e%2fetc` } };
  assert.equal(previewFrom(req), null);
});

test("leaving clears it", () => {
  const gone = leavePreview();
  assert.match(gone, new RegExp(`^${PREVIEW_COOKIE}=;`));
  assert.match(gone, /Max-Age=0/);
  assert.match(gone, /Path=\//, "cleared on the path it was set on, or it survives");
});

test("a preview says that it is one, and how to stop", () => {
  // A simulation you cannot tell from the real thing is worse than none,
  // because you will act on it.
  const bar = previewBanner(event);
  assert.match(bar, /Previewing/);
  assert.match(bar, /The 33 · London/);
  assert.match(bar, /November 2026/);
  assert.match(bar, /not the live site/);
  assert.match(bar, /href="\/preview\/exit"/);
  assert.match(bar, /position:fixed/);
});

test("the banner escapes what it is given", () => {
  const bar = previewBanner({
    ...event,
    name: '<script>alert("x")</script>'
  });
  assert.doesNotMatch(bar, /<script>alert/);
  assert.match(bar, /&lt;script&gt;/);
});
