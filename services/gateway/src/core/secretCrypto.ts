import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Secret Vault encryption primitives (master spec section 26: "Use
 * Encryption, AES-256-GCM or equivalent secure encryption"). Real
 * authenticated encryption via Node's built-in `crypto` module — no
 * external dependency needed, nothing hand-rolled: AES-256-GCM is a
 * standard, battle-tested algorithm and Node's implementation of it is
 * what's actually used here, not a reimplementation.
 *
 * GCM is authenticated encryption: it produces an auth tag alongside
 * the ciphertext, and decryption cryptographically verifies that tag.
 * Any tampering with the ciphertext, IV, or tag causes decryption to
 * throw rather than silently returning corrupted plaintext — this
 * property is specifically what secretCrypto.test.ts proves, not just
 * assumes.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // standard/recommended GCM nonce size

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

export class SecretCryptoError extends Error {}

/** Parses the master key from its base64 env-var form, validating its length. A wrong-length key is a real misconfiguration and must fail loudly, not silently truncate/pad. */
export function parseMasterKey(base64Key: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(base64Key, "base64");
  } catch (err) {
    throw new SecretCryptoError(`AXORA_SECRET_KEY is not valid base64: ${String(err)}`);
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `AXORA_SECRET_KEY must decode to exactly ${KEY_BYTES} bytes for AES-256, got ${key.length}. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

/** Encrypts plaintext under `key`. A fresh random IV is generated every call — reusing an IV with the same key is the one thing that genuinely breaks GCM's security guarantees, so this never accepts a caller-supplied IV. */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/** Decrypts and verifies a payload. Throws SecretCryptoError on any integrity failure — wrong key, tampered ciphertext/iv/tag — never returns corrupted or partial plaintext. */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(), // throws here if the auth tag doesn't verify
    ]);
    return plaintext.toString("utf8");
  } catch (err) {
    throw new SecretCryptoError(
      `Decryption failed — wrong key or tampered/corrupted data (never returns partial plaintext): ${String(err)}`,
    );
  }
}

/** Generates a fresh random master key, base64-encoded — for setup/rotation tooling, not used in the normal encrypt/decrypt path. */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}
