/**
 * Pinning images to IPFS via Pinata.
 *
 * The database holds the bytes and is the thing the site is served from; IPFS
 * holds the original as the record, and the CID goes in the database beside
 * the digest. Deliberately not the serving path: the build generates
 * responsive derivatives that took the homepage from 5 MB to 91 KB, and
 * serving full-size originals through a public gateway would undo that and add
 * a third party to every page load.
 *
 * Pinning is therefore never load-bearing. A failure is recorded and retried
 * later; the image is already durable the moment it is in Postgres.
 *
 * `fetchImpl` is injectable so the tests never touch the network and never
 * upload anything.
 */

const ENDPOINT = "https://api.pinata.cloud";

/** Only these are worth pinning. */
const IMAGE = /\.(jpe?g|png|webp|avif|gif|svg)$/i;

const MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml"
};

export function isImagePath(path) {
  return IMAGE.test(String(path ?? ""));
}

export function mimeFor(path) {
  const ext = String(path ?? "").split(".").pop()?.toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

export function createPinner({ jwt, gateway, fetchImpl = fetch, endpoint = ENDPOINT } = {}) {
  // Resolved on use, not at construction. The credentials live in the
  // database and are loaded into the environment during boot, which happens
  // after this module has been imported and the pinner built.
  const token = () => jwt ?? process.env.PINATA_JWT ?? "";
  const host = () => gateway ?? process.env.PINATA_GATEWAY ?? "";

  const configured = () => Boolean(token());

  const headers = () => ({ Authorization: `Bearer ${token()}` });

  /** Does the credential work? Used by the admin and by /api/health. */
  async function testAuth() {
    if (!configured()) return { ok: false, reason: "no PINATA_JWT" };
    try {
      const res = await fetchImpl(`${endpoint}/data/testAuthentication`, { headers: headers() });
      if (res.ok) return { ok: true, status: res.status };
      const reasons = {
        401: "Pinata rejected the JWT — it may be revoked or truncated",
        403: "the JWT lacks permission to pin files"
      };
      return { ok: false, status: res.status, reason: reasons[res.status] ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Pin one file and return its CID.
   *
   * The same bytes always produce the same CID, so re-pinning an unchanged
   * image is harmless — but the caller keys on the content digest to avoid
   * paying for the upload at all.
   */
  async function pin({ buffer, filename, mime = mimeFor(filename) }) {
    if (!configured()) throw new Error("Pinning is not configured: PINATA_JWT is missing.");

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mime }), filename);
    form.append(
      "pinataMetadata",
      JSON.stringify({ name: filename, keyvalues: { source: "regsymp-admin" } })
    );

    const res = await fetchImpl(`${endpoint}/pinning/pinFileToIPFS`, {
      method: "POST",
      headers: headers(),
      body: form
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Pinata returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const body = await res.json();
    const cid = body.IpfsHash ?? body.cid;
    if (!cid) throw new Error("Pinata accepted the upload but returned no CID.");
    return { cid, size: Number(body.PinSize ?? buffer.length) };
  }

  /**
   * A URL for a CID. The dedicated gateway when there is one: the public
   * ipfs.io gateway is rate-limited, so it is a poor default for anything
   * anybody actually clicks.
   */
  function gatewayUrl(cid) {
    if (!cid) return null;
    const dedicated = host().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return dedicated ? `https://${dedicated}/ipfs/${cid}` : `https://ipfs.io/ipfs/${cid}`;
  }

  return { configured, testAuth, pin, gatewayUrl };
}
