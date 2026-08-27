/**
 * Filename and HTML sanitising for the admin interface.
 *
 * Slugification is the highest-value part of this feature. Four speaker
 * photos and every carousel image once 404'd in production because their
 * referenced paths differed in case from the files on disk — invisible on
 * Windows and macOS, fatal on Linux. Any filename an editor supplies is
 * normalised here before it can reach the repository.
 */

const COMBINING_MARKS = /[̀-ͯ]/g;
const EXT_ALIASES = { jpeg: "jpg" };

// Elements whose *content* must not survive, not merely their tags.
const STRIP_WITH_CONTENT = /<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi;
const ANY_TAG = /<\/?([a-zA-Z0-9-]+)\b[^>]*>/g;

// Placeholder delimiter. NUL cannot appear in real editor input, and it is
// stripped from the input first, so it cannot be forged to smuggle a tag
// back in past the escaping step.
const SENTINEL = String.fromCharCode(0);

function asciiFold(text) {
  return String(text ?? "").normalize("NFD").replace(COMBINING_MARKS, "");
}

/** Lowercase, ASCII, hyphen-separated. Used for record slugs and filenames. */
export function slugify(text) {
  return asciiFold(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Normalise an uploaded filename to `slug.ext`.
 * Throws rather than guessing when there is nothing usable to work with,
 * so a nonsense upload fails loudly at the boundary.
 */
export function slugifyFilename(name) {
  const raw = String(name ?? "").trim();
  const lastDot = raw.lastIndexOf(".");
  const stem = lastDot > 0 ? raw.slice(0, lastDot) : raw;
  const rawExt = lastDot > 0 ? raw.slice(lastDot + 1) : "";

  let ext = slugify(rawExt);
  ext = EXT_ALIASES[ext] ?? ext;
  const base = slugify(stem);

  if (!base || !ext) throw new Error(`Unusable filename: ${JSON.stringify(name)}`);
  return `${base}.${ext}`;
}

/**
 * Reduce HTML to an allowlist of tags, stripping all attributes.
 *
 * `orgHtml` renders through Nunjucks `| safe`, so unfiltered admin input
 * would be a stored-XSS vector. Attributes are removed even from permitted
 * tags, which eliminates event handlers and `javascript:` URLs by
 * construction rather than by trying to detect them.
 *
 * Angle brackets that are not part of an allowed tag are escaped rather
 * than deleted. Deleting leaves orphans — `<scr<script>x</script>` strips
 * down to a stray `<scr` — and silently discards text an editor may have
 * meant, such as `a < b`.
 */
export function sanitiseHtml(html, allowedTags = []) {
  const allowed = new Set(allowedTags.map((t) => String(t).toLowerCase()));

  let out = String(html ?? "").split(SENTINEL).join("");

  let previous;
  // Repeat until stable, so a construct revealed only after an outer match
  // is removed cannot survive the pass.
  do {
    previous = out;
    out = out.replace(STRIP_WITH_CONTENT, "");
  } while (out !== previous);

  const kept = [];
  out = out.replace(ANY_TAG, (match, tag) => {
    const name = String(tag).toLowerCase();
    if (!allowed.has(name)) return "";
    kept.push(match.startsWith("</") ? `</${name}>` : `<${name}>`);
    return `${SENTINEL}${kept.length - 1}${SENTINEL}`;
  });

  out = out.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  out = out.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_, index) => kept[Number(index)]
  );

  return out.trim();
}
