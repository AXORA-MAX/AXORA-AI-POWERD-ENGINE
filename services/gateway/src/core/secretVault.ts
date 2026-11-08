import type { Store } from "../store.js";
import { encrypt, decrypt, parseMasterKey, SecretCryptoError } from "./secretCrypto.js";

/**
 * Secret Vault (master spec section 26): "Never expose API keys
 * directly to frontend clients. Use secure server-side secret storage
 * and encryption." This is that storage — real AES-256-GCM encryption
 * (secretCrypto.ts) at rest, access auditing via the action log that
 * already exists, and revocation.
 *
 * Deliberately NOT exposed: any way to read a secret's plaintext value
 * over HTTP. server.ts only wires up set/list-names/delete endpoints —
 * getSecret() exists for internal code (a future connector
 * implementation reading an API key to make an outbound call) to call
 * programmatically, never for an HTTP client to retrieve a value
 * through. This is the literal spec requirement, not an
 * over-cautious guess at one.
 */
export class SecretVault {
  constructor(private store: Store, private masterKeyBase64: string) {}

  private get masterKey(): Buffer {
    // Parsed on every call rather than cached at construction so a
    // misconfigured key fails at first real use with a clear error,
    // not silently at startup where it might go unnoticed in logs.
    return parseMasterKey(this.masterKeyBase64);
  }

  async setSecret(name: string, value: string): Promise<void> {
    const payload = encrypt(value, this.masterKey);
    await this.store.upsertSecret(name, payload);
    await this.store.logAction({
      action: `vault.set:${name}`,
      riskLevel: "high",
      approved: true,
      resultStatus: "success",
      detail: {},
    });
  }

  /**
   * Returns the decrypted plaintext, or undefined if no secret with
   * that name exists. Every call — found or not, success or failure —
   * is audited via the action log, since "who accessed which secret
   * and when" is exactly what section 26's "access auditing"
   * requirement means.
   */
  async getSecret(name: string): Promise<string | undefined> {
    const row = await this.store.getSecretRow(name);
    if (!row) {
      await this.store.logAction({
        action: `vault.get:${name}`,
        riskLevel: "high",
        approved: true,
        resultStatus: "failed",
        detail: { reason: "not_found" },
      });
      return undefined;
    }

    try {
      const value = decrypt({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag }, this.masterKey);
      await this.store.logAction({
        action: `vault.get:${name}`,
        riskLevel: "high",
        approved: true,
        resultStatus: "success",
        detail: {},
      });
      return value;
    } catch (err) {
      await this.store.logAction({
        action: `vault.get:${name}`,
        riskLevel: "high",
        approved: true,
        resultStatus: "failed",
        detail: { reason: err instanceof SecretCryptoError ? "decryption_failed" : "unknown_error" },
      });
      throw err;
    }
  }

  async deleteSecret(name: string): Promise<boolean> {
    const deleted = await this.store.deleteSecretRow(name);
    await this.store.logAction({
      action: `vault.delete:${name}`,
      riskLevel: "high",
      approved: true,
      resultStatus: deleted ? "success" : "failed",
      detail: {},
    });
    return deleted;
  }

  /** Names only — this is what's safe to expose over HTTP (GET /v1/vault/secrets), never the values. */
  async listSecretNames(): Promise<string[]> {
    return this.store.listSecretNames();
  }
}
