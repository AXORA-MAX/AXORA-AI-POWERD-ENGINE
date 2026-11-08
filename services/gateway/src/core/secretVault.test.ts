import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../store.js";
import { SecretVault } from "./secretVault.js";
import { generateMasterKey } from "./secretCrypto.js";

function freshVault(): SecretVault {
  const store = new SqliteStore(":memory:");
  return new SecretVault(store, generateMasterKey());
}

test("setSecret then getSecret round-trips the plaintext", async () => {
  const vault = freshVault();
  await vault.setSecret("anthropic_api_key", "sk-ant-test-value-123");
  const value = await vault.getSecret("anthropic_api_key");
  assert.equal(value, "sk-ant-test-value-123");
});

test("getSecret on a name that was never set returns undefined, not an error", async () => {
  const vault = freshVault();
  const value = await vault.getSecret("does_not_exist");
  assert.equal(value, undefined);
});

test("listSecretNames returns names but never values", async () => {
  const vault = freshVault();
  await vault.setSecret("key_one", "value_one_should_never_appear_here");
  await vault.setSecret("key_two", "value_two_should_never_appear_here");
  const names = await vault.listSecretNames();
  assert.deepEqual(names.sort(), ["key_one", "key_two"]);
  const serialized = JSON.stringify(names);
  assert.ok(!serialized.includes("value_one_should_never_appear_here"));
  assert.ok(!serialized.includes("value_two_should_never_appear_here"));
});

test("deleteSecret revokes it — a subsequent getSecret returns undefined", async () => {
  const vault = freshVault();
  await vault.setSecret("revoke_me", "temporary-value");
  assert.equal(await vault.getSecret("revoke_me"), "temporary-value");

  const deleted = await vault.deleteSecret("revoke_me");
  assert.equal(deleted, true);
  assert.equal(await vault.getSecret("revoke_me"), undefined);
});

test("deleteSecret on a nonexistent name returns false, not an error", async () => {
  const vault = freshVault();
  assert.equal(await vault.deleteSecret("never_existed"), false);
});

test("setSecret overwrites an existing value under the same name (rotation)", async () => {
  const vault = freshVault();
  await vault.setSecret("rotating_key", "old-value");
  await vault.setSecret("rotating_key", "new-value");
  assert.equal(await vault.getSecret("rotating_key"), "new-value");
  assert.deepEqual(await vault.listSecretNames(), ["rotating_key"]);
});

test("every vault operation is audited via the action log", async () => {
  const store = new SqliteStore(":memory:");
  const vault = new SecretVault(store, generateMasterKey());

  await vault.setSecret("audited_key", "some-value");
  await vault.getSecret("audited_key");
  await vault.getSecret("missing_key");
  await vault.deleteSecret("audited_key");

  const actions = await store.listActions();
  const actionNames = actions.map((a) => a.action).sort();
  assert.deepEqual(actionNames, [
    "vault.delete:audited_key",
    "vault.get:audited_key",
    "vault.get:missing_key",
    "vault.set:audited_key",
  ]);

  const failedGet = actions.find((a) => a.action === "vault.get:missing_key");
  assert.equal(failedGet?.resultStatus, "failed");

  const serializedLog = JSON.stringify(actions);
  assert.ok(!serializedLog.includes("some-value"));
});

test("getSecret with a different master key than the data was encrypted under throws, not returns garbage", async () => {
  const store = new SqliteStore(":memory:");
  const vaultA = new SecretVault(store, generateMasterKey());
  await vaultA.setSecret("cross_key_test", "original-value");

  const vaultB = new SecretVault(store, generateMasterKey());
  await assert.rejects(() => vaultB.getSecret("cross_key_test"));
});
