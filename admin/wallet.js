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

/** A pass colour per badge category, from the presets the free tier allows. */
const PRESETS = {
  "#B8963A": "orange",
  "#1C2B4A": "dark",
  "#6B7FA0": "blue"
};

function presetFor(colour) {
  return PRESETS[String(colour ?? "").toUpperCase()] ?? "dark";
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

    colorPreset: presetFor(ticket.colour),
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
