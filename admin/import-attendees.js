/**
 * Reading a pasted guest list.
 *
 * People will paste whatever they have: a CSV export, a block copied out of a
 * spreadsheet (tab-separated), a column of addresses, or a list from a mail
 * client in "Name <address>" form. Refusing anything but one exact shape
 * moves the work onto whoever is pasting, so this accepts all of them and
 * reports precisely what it understood.
 *
 * Pure on purpose: no database, no network. Every awkward input is a test
 * rather than something to discover with a hundred real rows.
 */

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]{2,}$/;

/** "Ada Lovelace <ada@example.com>" — what mail clients hand you. */
const ANGLED = /^\s*(?:"([^"]*)"|([^<]*?))\s*<\s*([^>\s]+)\s*>\s*$/;

const HEADERS = {
  email: ["email", "e-mail", "mail", "address", "email address"],
  firstName: ["first", "firstname", "first name", "forename", "given name"],
  lastName: ["last", "lastname", "last name", "surname", "family name"],
  company: ["company", "organisation", "organization", "org", "employer", "firm"],
  position: ["position", "title", "role", "job title"],
  country: ["country"]
};

/** Which delimiter is this? Tabs win, because a spreadsheet paste uses them. */
export function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 5).join("\n");
  if (sample.includes("\t")) return "\t";
  const commas = (sample.match(/,/g) ?? []).length;
  const semis = (sample.match(/;/g) ?? []).length;
  if (semis > commas) return ";";
  if (commas > 0) return ",";
  return null; // one field per line
}

/** Split one line, honouring double quotes around fields containing the delimiter. */
export function splitLine(line, delimiter) {
  if (!delimiter) return [line.trim()];

  const fields = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === delimiter && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current.trim());
  return fields;
}

/** Does this row name the columns rather than hold data? */
const normalise = (label) =>
  String(label ?? "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

// Compared after the same normalisation as the incoming labels. Storing them
// raw meant "e-mail" normalised to "e mail" and matched nothing, so a
// perfectly good header was treated as data.
const ALIASES = Object.fromEntries(
  Object.entries(HEADERS).map(([key, list]) => [key, list.map(normalise)])
);

function headerMap(fields) {
  const labels = fields.map(normalise);
  if (!labels.some((f) => ALIASES.email.includes(f))) return null;

  const map = {};
  labels.forEach((label, index) => {
    for (const [key, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(label) && !(key in map)) map[key] = index;
    }
  });
  return "email" in map ? map : null;
}

/** Pull an address out of a field, whatever it is wrapped in. */
function addressIn(field) {
  const value = String(field ?? "").trim();
  if (EMAIL.test(value)) return { email: value, name: null };

  const angled = ANGLED.exec(value);
  if (angled) {
    const email = angled[3];
    if (EMAIL.test(email)) return { email, name: (angled[1] ?? angled[2] ?? "").trim() || null };
  }
  return null;
}

/** Split "Ada Lovelace" into parts, keeping multi-word surnames together. */
export function splitName(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * Parse a pasted block into records.
 *
 * Returns every line's outcome, including the ones it could not read: a
 * silent drop in an import of a hundred people is how somebody ends up
 * missing from the guest list with nobody knowing why.
 */
export function parseAttendees(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return { rows: [], problems: [], delimiter: null, hadHeader: false };

  const delimiter = detectDelimiter(text);
  const first = splitLine(lines[0], delimiter);
  const map = headerMap(first);

  const rows = [];
  const problems = [];
  const seen = new Set();

  for (const [index, line] of lines.entries()) {
    if (index === 0 && map) continue; // the header itself

    const fields = splitLine(line, delimiter);
    let record = null;

    if (map) {
      const found = addressIn(fields[map.email]);
      if (found) {
        const pick = (key) => (key in map ? (fields[map[key]] || null) : null);
        // A name in the address field wins only where no column supplied one.
        const fallback = splitName(found.name);
        record = {
          email: found.email,
          firstName: pick("firstName") ?? fallback.firstName,
          lastName: pick("lastName") ?? fallback.lastName,
          company: pick("company"),
          position: pick("position"),
          country: pick("country")
        };
      }
    } else {
      // No header, so find the address wherever it is and read the rest in
      // the order people write it: name, then surname, then company.
      const at = fields.findIndex((f) => addressIn(f));
      if (at !== -1) {
        const found = addressIn(fields[at]);
        const rest = fields.filter((_, i) => i !== at);
        let named;
        let offset;

        if (found.name) {
          // The address carried its own name, so every other field is extra.
          named = splitName(found.name);
          offset = 0;
        } else if (rest.length >= 2 && rest[0] && !/\s/.test(rest[0])) {
          // Two or more fields and the first is a single word: these are
          // separate name columns, which is what a spreadsheet gives.
          named = { firstName: rest[0], lastName: rest[1] || null };
          offset = 2;
        } else {
          // One field, or a first field with a space in it: a whole name.
          named = splitName(rest[0] ?? "");
          offset = 1;
        }

        record = {
          email: found.email,
          firstName: named.firstName,
          lastName: named.lastName,
          company: rest[offset] || null,
          position: rest[offset + 1] || null,
          country: null
        };
      }
    }

    if (!record) {
      problems.push({ line: index + 1, text: line, reason: "no email address found" });
      continue;
    }

    const key = record.email.toLowerCase();
    if (seen.has(key)) {
      problems.push({ line: index + 1, text: line, reason: "repeated in this paste" });
      continue;
    }
    seen.add(key);

    record.email = key;
    rows.push(record);
  }

  return { rows, problems, delimiter, hadHeader: Boolean(map) };
}
