import { test } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, parseMasterKey, generateMasterKey, SecretCryptoError } from "./secretCrypto.js";

const TEST_KEY = parseMasterKey(generateMasterKey());

test("encrypt/decrypt round-trips plaintext correctly", () => {
  const payload = encrypt("sk-ant-super-secret-api-key", TEST_KEY);
  const plaintext = decrypt(payload, TEST_KEY);
  assert.equal(plaintext, "sk-ant-super-secret-api-key");
});

test("ciphertext is never the plaintext in disguise (actually encrypted, not just base64'd)", () => {
  const payload = encrypt("my-password-123", TEST_KEY);
  assert.ok(!payload.ciphertext.includes("my-password-123"));
  assert.notEqual(Buffer.from(payload.ciphertext, "base64").toString("utf8"), "my-password-123");
});

test("two encryptions of the same plaintext use different IVs and produce different ciphertext", () => {
  const a = encrypt("same plaintext", TEST_KEY);
  const b = encrypt("same plaintext", TEST_KEY);
  assert.notEqual(a.iv, b.iv, "IV reuse would break GCM's security guarantees");
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(decrypt(a, TEST_KEY), "same plaintext");
  assert.equal(decrypt(b, TEST_KEY), "same plaintext");
});

test("tampering with the ciphertext is detected, never silently decrypts to garbage", () => {
  const payload = encrypt("sensitive value", TEST_KEY);
  const tamperedBytes = Buffer.from(payload.ciphertext, "base64");
  tamperedBytes[0] ^= 0xff;
  const tampered = { ...payload, ciphertext: tamperedBytes.toString("base64") };
  assert.throws(() => decrypt(tampered, TEST_KEY), SecretCryptoError);
});

test("tampering with the auth tag is detected", () => {
  const payload = encrypt("sensitive value", TEST_KEY);
  const tamperedTag = Buffer.from(payload.authTag, "base64");
  tamperedTag[0] ^= 0xff;
  const tampered = { ...payload, authTag: tamperedTag.toString("base64") };
  assert.throws(() => decrypt(tampered, TEST_KEY), SecretCryptoError);
});

test("tampering with the IV is detected", () => {
  const payload = encrypt("sensitive value", TEST_KEY);
  const tamperedIv = Buffer.from(payload.iv, "base64");
  tamperedIv[0] ^= 0xff;
  const tampered = { ...payload, iv: tamperedIv.toString("base64") };
  assert.throws(() => decrypt(tampered, TEST_KEY), SecretCryptoError);
});

test("decrypting with the wrong key fails rather than returning wrong plaintext", () => {
  const payload = encrypt("sensitive value", TEST_KEY);
  const wrongKey = parseMasterKey(generateMasterKey());
  assert.throws(() => decrypt(payload, wrongKey), SecretCryptoError);
});

test("parseMasterKey rejects a key of the wrong length", () => {
  assert.throws(() => parseMasterKey(Buffer.from("too short").toString("base64")), SecretCryptoError);
  assert.throws(() => parseMasterKey(Buffer.alloc(16).toString("base64")), SecretCryptoError);
});

test("parseMasterKey rejects non-32-byte decodes from malformed input", () => {
  assert.throws(() => parseMasterKey("not valid base64 at all!!! {{{"), SecretCryptoError);
});

test("generateMasterKey always produces a key parseMasterKey accepts", () => {
  for (let i = 0; i < 5; i++) {
    const key = generateMasterKey();
    assert.doesNotThrow(() => parseMasterKey(key));
  }
});

test("generateMasterKey produces different keys each call", () => {
  const a = generateMasterKey();
  const b = generateMasterKey();
  assert.notEqual(a, b);
});
