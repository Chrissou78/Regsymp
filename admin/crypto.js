import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encrypting what gets pinned to IPFS.
 *
 * IPFS is public by construction: anything pinned can be fetched by anyone who
 * learns the CID, and it cannot be recalled once it has propagated. Encrypting
 * before upload means a CID on its own reveals nothing.
 *
 * AES-256-GCM, so the ciphertext is authenticated as well as hidden — a
 * corrupted or tampered file fails to decrypt rather than yielding rubbish
 * that gets written over a good original.
 *
 * The layout is deliberately self-describing:
 *
 *   "RSENC1"  6 bytes   magic and version, so an encrypted file is
 *                       recognisable without a database lookup
 *   iv       12 bytes   fresh per file; GCM's nonce
 *   tag      16 bytes   authentication tag
 *   body      n bytes   ciphertext
 */

const MAGIC = Buffer.from("RSENC1", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER = MAGIC.length + IV_BYTES + TAG_BYTES;

export const KEY_BYTES = 32;

/** A fresh key, as hex. Shown once and stored; never derived from a password. */
export function generateKey() {
  return randomBytes(KEY_BYTES).toString("hex");
}

/**
 * Accept a key as hex or base64 and check its length.
 *
 * A key that is silently wrong produces files nobody can ever read, and the
 * failure shows up only when something needs decrypting — which may be the
 * moment the original is already gone.
 */
export function parseKey(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("No encryption key is set.");

  let key;
  if (/^[0-9a-fA-F]+$/.test(text) && text.length === KEY_BYTES * 2) {
    key = Buffer.from(text, "hex");
  } else {
    key = Buffer.from(text, "base64");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `The encryption key must be ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex characters); got ${key.length}.`
    );
  }
  return key;
}

/** Is this already one of ours? */
export function isEncrypted(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= HEADER &&
    timingSafeEqual(buffer.subarray(0, MAGIC.length), MAGIC)
  );
}

export function encrypt(plaintext, keyValue) {
  const key = parseKey(keyValue);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(payload, keyValue) {
  const buffer = Buffer.from(payload);
  if (!isEncrypted(buffer)) {
    throw new Error("That file is not encrypted, or not by this application.");
  }

  const key = parseKey(keyValue);
  const iv = buffer.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buffer.subarray(MAGIC.length + IV_BYTES, HEADER);
  const body = buffer.subarray(HEADER);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // GCM fails closed: a wrong key and a tampered file are indistinguishable,
    // and both mean the same thing — do not trust these bytes.
    throw new Error("Could not decrypt: wrong key, or the file has been altered.");
  }
}
