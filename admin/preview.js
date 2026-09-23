import { escape } from "./render.js";

/**
 * Looking at an event before anybody else does.
 *
 * Not a mock-up of the site and not a page of its own: it is the site, built
 * from a draft event's own speakers and sponsors, served from a separate
 * directory. The point of preparing an event months ahead is to be able to
 * walk through it, and walking through it means following the links.
 *
 * Which is why it is a cookie rather than a query parameter. `?preview=london`
 * would survive exactly one click: every link on the page points at /speakers
 * and /partners, and the second page would quietly be the live site again --
 * the most misleading possible outcome for a feature whose whole job is to
 * show you what is not live yet.
 *
 * The cookie is a hint, not a key. Every request still checks for a signed-in
 * administrator, so setting it by hand gets an anonymous visitor nothing.
 */

export const PREVIEW_COOKIE = "regsymp_preview";

/** The event being previewed, if the browser claims to be previewing one. */
export function previewFrom(req) {
  const raw = req.headers.cookie ?? "";
  const found = raw.match(new RegExp(`(?:^|;\\s*)${PREVIEW_COOKIE}=([^;]*)`));
  if (!found) return null;
  const slug = decodeURIComponent(found[1]);
  // Whatever arrives is going into a file path. Only the shape a slug has.
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}

export function enterPreview(slug) {
  return `${PREVIEW_COOKIE}=${encodeURIComponent(slug)}; Secure; SameSite=Lax; Path=/; Max-Age=7200`;
}

export function leavePreview() {
  return `${PREVIEW_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * The bar that stops somebody mistaking a preview for the site.
 *
 * The same reasoning as the sleep banner: a simulation you cannot tell from
 * the real thing is worse than no simulation, because you will act on it.
 */
export function previewBanner(event) {
  return `<div role="status" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#1C2B4A;color:#F6F3EC;padding:9px 16px;text-align:center;font:500 13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,0.35)">
  Previewing <strong>${escape(event.name)}</strong>, ${escape(event.whenLabel)} &mdash; a ${escape(
    event.status
  )} event. This is not the live site.
  <a href="/preview/exit" style="color:#B8963A;text-decoration:underline;margin-left:10px">Leave the preview</a>
</div>`;
}
