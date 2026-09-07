import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_BYTES, decrypt, encrypt, generateKey, isEncrypted, parseKey } from "../admin/crypto.js";

/** A real 1×1 PNG, so the magic bytes being hidden means something. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwACAQEAlSbBpQAAAABJRU5ErkJggg==",
  "base64"
);

test("a key is the right size and unpredictable", () => {
  const a = generateKey();
  const b = generateKey();
  assert.equal(Buffer.from(a, "hex").length, KEY_BYTES);
  assert.notEqual(a, b);
});

test("ciphertext round-trips to exactly the original bytes", () => {
  const key = generateKey();
  assert.deepEqual(decrypt(encrypt(PNG, key), key), PNG);
});

test("the file type is not visible in the ciphertext", () => {
  // A pinned image whose PNG or JPEG header survived would be identifiable,
  // and its size and type alone leak more than they look like they do.
  const sealed = encrypt(PNG, generateKey());
  assert.ok(!sealed.subarray(6).includes(Buffer.from("PNG")), "the PNG signature survived");
  assert.ok(!sealed.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "the magic bytes survived");
});

test("the same file encrypted twice gives different ciphertext", () => {
  // A fresh IV each time. Otherwise identical images would be recognisable as
  // identical from the ciphertext alone, without decrypting anything.
  const key = generateKey();
  const first = encrypt(PNG, key);
  const second = encrypt(PNG, key);

  assert.ok(!first.equals(second));
  assert.deepEqual(decrypt(first, key), PNG);
  assert.deepEqual(decrypt(second, key), PNG);
});

test("a wrong key fails rather than returning rubbish", () => {
  // GCM authenticates, so this fails closed. Returning plausible-looking bytes
  // would be far worse: they could be written over a good original.
  const sealed = encrypt(PNG, generateKey());
  assert.throws(() => decrypt(sealed, generateKey()), /wrong key, or the file has been altered/);
});

test("a tampered file fails, wherever it was altered", () => {
  const key = generateKey();
  const sealed = encrypt(PNG, key);

  for (const at of [6, 20, sealed.length - 1]) {
    const tampered = Buffer.from(sealed);
    tampered[at] ^= 0x01;
    assert.throws(() => decrypt(tampered, key), /wrong key, or the file has been altered/, `byte ${at}`);
  }
});

test("truncation is detected", () => {
  const key = generateKey();
  const sealed = encrypt(PNG, key);
  assert.throws(() => decrypt(sealed.subarray(0, sealed.length - 4), key));
  assert.throws(() => decrypt(sealed.subarray(0, 10), key), /not encrypted/);
});

test("encrypted files are recognisable without a database lookup", () => {
  assert.equal(isEncrypted(encrypt(PNG, generateKey())), true);
  assert.equal(isEncrypted(PNG), false);
  assert.equal(isEncrypted(Buffer.alloc(0)), false);
  assert.equal(isEncrypted(Buffer.from("RSENC")), false, "too short to be one of ours");
});

test("plaintext is refused as input to decrypt", () => {
  // Better than a confusing GCM error: this one says what is actually wrong.
  assert.throws(() => decrypt(PNG, generateKey()), /not encrypted/);
});

test("a key of the wrong length is rejected on sight", () => {
  // A silently wrong key produces files nobody can read, and the failure only
  // shows up later — possibly once the original is gone.
  for (const bad of ["", "short", "a".repeat(63), "a".repeat(65), "zz".repeat(32)]) {
    assert.throws(() => parseKey(bad), /encryption key|No encryption key/);
  }
  assert.doesNotThrow(() => parseKey(generateKey()));
});

test("a base64 key of the right length is accepted", () => {
  // Whatever a password manager hands back should work.
  const key = Buffer.from(generateKey(), "hex");
  assert.deepEqual(parseKey(key.toString("base64")), key);
});

test("encryption adds a bounded, predictable overhead", () => {
  // 6 magic + 12 iv + 16 tag. Worth knowing, because it is paid per file and
  // these are pinned to a metered service.
  const sealed = encrypt(PNG, generateKey());
  assert.equal(sealed.length - PNG.length, 34);
});
