import { slugify, sanitiseHtml } from "./sanitise.js";

/**
 * Declarative description of every editable collection.
 *
 * One schema drives the list view, the form, validation and the write, so
 * adding a collection later is an entry here rather than new UI code.
 *
 * kind:
 *   "array"  - a flat list of records
 *   "nested" - a list of groups, each holding a child list (partner tiers)
 *   "agenda" - edition -> day -> list of sessions
 *   "object" - a single record (site settings)
 */

const F = (name, type, extra = {}) => ({ name, type, ...extra });

export const SCHEMAS = {
  speakers: {
    file: "src/_data/speakers.json",
    kind: "array",
    label: "Speakers",
    identify: (r) => r.name,
    fields: [
      F("slug", "slug", { from: "name", unique: true }),
      F("name", "text", { required: true, max: 120 }),
      F("role", "text", { required: true, max: 160 }),
      F("org", "text", { max: 200 }),
      F("orgHtml", "html", {
        allow: ["strong", "em", "br"],
        max: 400,
        help: "Optional. Use to emphasise part of the organisation name."
      }),
      F("bio", "textarea", { max: 2000 }),
      F("photo", "image", { dir: "src/assets/images/speakers" }),
      F("linkedin", "url", { max: 300 })
    ]
  },

  partners: {
    file: "src/_data/partners.json",
    kind: "nested",
    label: "Partners",
    identify: (r) => r.label,
    childKey: "logos",
    childLabel: "Logos",
    fields: [
      F("label", "text", {
        required: true,
        max: 60,
        help: "The heading shown on the partners page, e.g. Session Partner."
      }),
      F("tier", "slug", {
        from: "label",
        max: 60,
        help: "Styling class. Leave blank and it is derived from the label."
      })
    ],
    childFields: [
      F("name", "text", { required: true, max: 120 }),
      F("file", "image", { dir: "src/assets/images", required: true }),
      F("modifier", "text", {
        max: 60,
        help: "Optional size adjustment: logo-smaller, logo-larger or logo-largest. Leave blank for the default."
      })
    ]
  },

  faq: {
    file: "src/_data/faq.json",
    kind: "array",
    label: "FAQ",
    identify: (r) => r.question,
    fields: [
      F("question", "text", { required: true, max: 200 }),
      F("answer", "textarea", { required: true, max: 2000 })
    ]
  },

  themes: {
    file: "src/_data/themes.json",
    kind: "array",
    label: "Programme themes",
    identify: (r) => r.title,
    fields: [
      F("num", "text", { required: true, max: 4 }),
      F("title", "text", { required: true, max: 120 }),
      F("description", "textarea", { required: true, max: 600 })
    ]
  },

  editions: {
    file: "src/_data/editions.json",
    kind: "array",
    label: "Editions",
    identify: (r) => r.label,
    fields: [
      F("key", "slug", { required: true, max: 40, unique: true }),
      F("label", "text", { required: true, max: 80 }),
      F("url", "text", { required: true, max: 120, help: "Site path, e.g. /london-2027/" })
    ]
  },

  agenda: {
    file: "src/_data/agenda.json",
    kind: "agenda",
    label: "Agenda",
    identify: (r) => r.title,
    fields: [
      F("time", "text", { required: true, max: 10 }),
      F("title", "text", { required: true, max: 200 }),
      F("badge", "text", { max: 60 }),
      F("break", "checkbox")
    ]
  },

  site: {
    file: "src/_data/site.json",
    kind: "object",
    label: "Site settings",
    identify: () => "Site settings",
    fields: [
      F("name", "text", { required: true, max: 80 }),
      F("url", "url", { required: true, max: 200 }),
      F("email", "text", { required: true, max: 200 }),
      F("linkedin", "url", { max: 300 }),
      F("twitter", "url", { max: 300 }),
      F("legalName", "text", { required: true, max: 120 }),
      F("themeColor", "text", { required: true, max: 20 }),
      F("defaultOgImage", "text", { required: true, max: 200 })
    ]
  }
};

export function getSchema(name) {
  return Object.prototype.hasOwnProperty.call(SCHEMAS, name) ? SCHEMAS[name] : undefined;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validate and coerce one record against a schema.
 *
 * Returns { ok, value, errors }. Empty optional fields are omitted from
 * `value` rather than written as empty strings, so the JSON stays as terse
 * as the hand-written files it replaces.
 */
export function validateRecord(schema, input, fields = schema.fields) {
  const errors = [];
  const value = {};

  for (const field of fields) {
    let raw = input[field.name];

    if (field.type === "checkbox") {
      if (raw === true || raw === "on" || raw === "true") value[field.name] = true;
      continue;
    }

    raw = typeof raw === "string" ? raw.trim() : (raw ?? "");

    // A slug field derives from another field when left blank.
    if (!raw && field.type === "slug" && field.from) {
      raw = slugify(String(input[field.from] ?? ""));
    }

    if (!raw) {
      if (field.required) {
        errors.push({ field: field.name, message: `${field.name} is required.` });
      }
      continue;
    }

    if (field.max && String(raw).length > field.max) {
      errors.push({
        field: field.name,
        message: `${field.name} is too long (maximum ${field.max} characters).`
      });
      continue;
    }

    if (field.type === "url" && !isHttpUrl(raw)) {
      errors.push({ field: field.name, message: `${field.name} must be a http(s) URL.` });
      continue;
    }

    if (field.type === "slug") raw = slugify(raw);
    if (field.type === "html") raw = sanitiseHtml(raw, field.allow ?? []);

    if (raw !== "") value[field.name] = raw;
  }

  return { ok: errors.length === 0, value, errors };
}
