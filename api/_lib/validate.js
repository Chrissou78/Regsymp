const REQUIRED = ["name", "email", "company", "role"];
const MAX = { name: 120, email: 200, company: 160, role: 160, mobile: 40, message: 2000 };
const MIN_FILL_MS = 3000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LABEL = {
  name: "name",
  email: "email address",
  company: "company",
  role: "role"
};

/**
 * Validate an invitation request submission.
 * Returns { ok: true, data } or { ok: false, error }.
 *
 * Kept free of network and environment access so it can be unit tested.
 */
export function validateSubmission(body = {}) {
  // Honeypot: a real person never sees this field.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return { ok: false, error: "Rejected." };
  }

  // Bots submit near-instantly; people take a few seconds.
  const started = Number(body.startedAt);
  if (Number.isFinite(started) && started > 0 && Date.now() - started < MIN_FILL_MS) {
    return { ok: false, error: "Rejected." };
  }

  for (const field of REQUIRED) {
    if (typeof body[field] !== "string" || body[field].trim() === "") {
      return { ok: false, error: `Please provide your ${LABEL[field]}.` };
    }
  }

  if (!EMAIL.test(body.email.trim())) {
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
