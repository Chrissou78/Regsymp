/**
 * Apple and Google Wallet passes, via WalletWallet.
 *
 * Signing a .pkpass yourself needs an Apple Pass Type ID certificate, and a
 * Google pass needs a service account and an issuer id. Neither belongs in a
 * container that gets replaced on every deploy, so a service holds them and
 * this sends it the pass content.
 *
 * The one field that matters is barcodeValue: it carries the same /t/<code>
 * URL as the printed badge and the ticket page, so a single scan at the door
 * works whether somebody presents a phone, a wallet pass, or card stock.
 *
 * Without a key the rest of the ticket still works. The pass is an extra way
 * to carry a badge, never the badge itself.
 */

const ENDPOINT = "https://api.walletwallet.dev/api/passes";

/**
 * The pass background.
 *
 * `color` takes the category's own hex, so a pass looks like the badge it
 * stands for. It is a paid feature at the provider, so `colorPreset` is sent
 * alongside as the fallback, and that fallback is always "dark" -- the navy
 * the rest of the site is built on. The presets offered are dark, blue,
 * green, red, purple and orange: there is no gold among them, and a Speaker
 * pass mapped to orange looked nothing like the event.
 *
 * So: exactly right where the plan allows it, on-brand where it does not,
 * and never orange.
 */
const FALLBACK_PRESET = "dark";

/** #RRGGBB, or null if there is nothing usable to send. */
function hex(colour) {
  const value = String(colour ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null;
}

/** Trim to the API's limit without cutting mid-word where it can be helped. */
function fit(value, limit) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return space > limit * 0.6 ? cut.slice(0, space) : cut;
}

/**
 * The pass content for one badge.
 *
 * Exported so it can be read and tested without a key or a network.
 */
export function passBodyFor({ guest, ticket, checkinUrl }) {
  const fields = (list) => list.filter((f) => f.value);

  return {
    organizationName: "RegSymp",
    description: `RegSymp 2026 ${ticket.categoryLabel} badge`,
    logoText: "RegSymp",

    barcodeValue: checkinUrl,
    barcodeFormat: "QR",
    // Shown under the code so a person can read out what a scanner cannot.
    barcodeAltText: fit(ticket.number === null ? ticket.categoryLabel : `No. ${ticket.number}`, 128),

    headerFields: fields([{ label: "Badge", value: ticket.label }]),
    primaryFields: fields([{ label: "Name", value: guest.name ?? guest.email }]),
    secondaryFields: fields([
      { label: "Access", value: ticket.categoryLabel },
      { label: "Company", value: guest.company }
    ]),
    backFields: fields([
      { label: "Venue", value: "Palma de Mallorca" },
      { label: "Dates", value: "14–15 September 2026" },
      {
        label: "Side events",
        value: (ticket.areas ?? []).map((a) => a.replace(/^side:/, "")).join(", ")
      },
      {
        label: "Chatham House Rule",
        value:
          "Remarks made at RegSymp may be reported, but neither the identity " +
          "nor the affiliation of the speaker may be revealed."
      },
      { label: "Badge", value: ticket.code ? "This pass is personal and not transferable." : null }
    ]),

    colorPreset: FALLBACK_PRESET,
    ...(hex(ticket.colour) ? { color: hex(ticket.colour) } : {}),
    sharingProhibited: true
  };
}

export function createWallet({ env, fetchImpl = globalThis.fetch } = {}) {
  const key = () => env("WALLETWALLET_API_KEY");
  const configured = () => Boolean(key());

  async function call(path, method, body) {
    if (!configured()) {
      throw new Error("Wallet passes are not configured: WALLETWALLET_API_KEY is missing.");
    }

    const res = await fetchImpl(`${ENDPOINT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();

    // An exact colour is a paid feature. If that is the only objection, the
    // pass is still worth having: drop the colour, keep the navy preset, and
    // try once more. A badge that is the wrong shade of blue beats no badge.
    if (!res.ok && "color" in body && /colou?r|\bpro\b|plan|upgrade/i.test(text)) {
      const { color, ...plain } = body;
      console.warn(`wallet: ${color} needs a paid plan, sending the preset instead`);
      return call(path, method, plain);
    }

    if (!res.ok) {
      // The provider's own words, trimmed: they name the offending field, and
      // guessing at it from a status code alone wastes an afternoon.
      throw new Error(`Wallet pass refused (${res.status}): ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  }

  return {
    configured,

    /**
     * Make a pass for a badge.
     *
     * Returns the serial to keep and the share URL to send somebody to: that
     * page offers the right button per device — Add to Apple Wallet on an
     * iPhone, Save to Google Wallet on Android, a QR code on a desktop — which
     * is one fewer thing for this site to get wrong about a user agent.
     */
    async createPass({ guest, ticket, checkinUrl }) {
      const made = await call("", "POST", passBodyFor({ guest, ticket, checkinUrl }));
      return {
        serial: made.serialNumber,
        url: made.shareUrl,
        googleSaveUrl: made.googleSaveUrl ?? null
      };
    },

    /** Push changed details to every device that installed the pass. */
    async updatePass({ serial, guest, ticket, checkinUrl }) {
      return call(`/${encodeURIComponent(serial)}`, "PUT", passBodyFor({ guest, ticket, checkinUrl }));
    }
  };
}
