// The lock table, row by row, against the vault's own gates. Run: node --test test/capabilities.test.mjs
//
// Each row is what the contract does for the OWNER in each lock state (✅ allowed, or the reason it
// refuses). When the vault changes a gate, the row here changes with it — web carries the same
// table (test/vault-capabilities.test.mjs), so the two apps cannot drift apart silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capability,
  PERM_INTENT,
  PERM_MARKET_TRADE,
  PERM_SUPPLY,
  PERM_YIELD,
  LOCKED_SALE_SINCE,
} from "../src/vault/capabilities.ts";

const OK = "ok";
const T = "locked_temp";
const F = "locked_forever";

// [action, options, unlocked, emergency lock, forever lock]
const OWNER_TABLE = [
  ["deposit", {}, OK, T, F],
  ["withdraw", {}, OK, OK, OK],
  ["claimWithdrawal", {}, OK, OK, OK],
  ["autoYield", {}, OK, T, F],
  ["setAutoYielding", {}, OK, T, F],
  ["marketTrade", {}, OK, T, F],
  ["placeIntentOrder", { buysStablecoin: true }, OK, OK, OK],
  ["placeIntentOrder", { buysStablecoin: false }, OK, "stablecoin_buy_only", "stablecoin_buy_only"],
  ["placeIntentOrder", {}, OK, OK, OK],
  ["approveIntentSpender", {}, OK, OK, OK],
  ["cancelIntentOrder", {}, OK, T, F],
  ["send", {}, OK, T, F],
  ["sendToWhitelistedRecipient", {}, OK, OK, OK],
  ["addWhitelistedRecipient", {}, OK, T, F],
  ["removeWhitelistedRecipient", {}, OK, T, F],
  ["retrieve721", {}, OK, T, F],
  ["updateRisk", {}, OK, T, F],
  ["setTokenAsGas", {}, OK, T, F],
  ["setAssetManager", {}, OK, T, F],
  ["transferOwnership", {}, OK, T, F],
  ["updateAllowList", {}, OK, T, F],
  ["useBittyAllowList", {}, OK, OK, OK],
  ["setAutoYieldTrigger", {}, OK, T, F],
  ["upgradeVault", {}, OK, T, F],
  ["upgradeProtocol", {}, OK, T, F],
  ["emergencyLock", {}, OK, T, F],
  ["unlock", {}, "not_locked", OK, F],
  ["foreverLock", {}, OK, OK, F],
  ["relayGas", {}, OK, OK, F],
];

const verdict = (g) => (g.allowed ? OK : g.reason);

test("owner: every action in every lock state", () => {
  for (const [action, opts, ...expected] of OWNER_TABLE) {
    for (const level of [0, 1, 2]) {
      const got = verdict(capability(action, { lockLevel: level, role: "owner" }, opts));
      assert.equal(got, expected[level], `${action} ${JSON.stringify(opts)} at lock ${level}`);
    }
  }
});

test("an unknown lock level reads as unlocked", () => {
  assert.equal(verdict(capability("send", { lockLevel: null, role: "owner" })), OK);
  assert.equal(verdict(capability("send", { lockLevel: null, role: null })), OK);
});

test("an allowance of 0 turns its feature off, and only that one", () => {
  const state = { lockLevel: 0, role: "owner", sendAllowanceOff: true, marketTradeOff: true };
  assert.equal(verdict(capability("send", state)), "send_allowance_off");
  assert.equal(verdict(capability("marketTrade", state)), "market_trade_off");
  assert.equal(verdict(capability("sendToWhitelistedRecipient", state)), OK);
  assert.equal(verdict(capability("placeIntentOrder", state)), OK);
  // A lock is the stronger reason.
  assert.equal(verdict(capability("send", { ...state, lockLevel: 1 })), T);
});

test("asset manager: only what its permissions name", () => {
  const all = PERM_YIELD | PERM_SUPPLY | PERM_MARKET_TRADE | PERM_INTENT;
  const mgr = (permissions, lockLevel = 0) => ({ lockLevel, role: "assetManager", managerPermissions: permissions });

  assert.equal(verdict(capability("deposit", mgr(PERM_SUPPLY))), OK);
  assert.equal(verdict(capability("deposit", mgr(PERM_SUPPLY), { staking: true })), "no_permission");
  assert.equal(verdict(capability("deposit", mgr(PERM_YIELD), { staking: true })), OK);
  assert.equal(verdict(capability("marketTrade", mgr(PERM_INTENT))), "no_permission");
  assert.equal(verdict(capability("placeIntentOrder", mgr(PERM_INTENT))), OK);
  assert.equal(verdict(capability("approveIntentSpender", mgr(PERM_MARKET_TRADE))), "no_permission");
  // Before 1.0.6 (and with the release unknown) any live manager may bring value home and cancel
  // orders, whatever its permissions.
  assert.equal(verdict(capability("withdraw", mgr(0))), OK);
  assert.equal(verdict(capability("claimWithdrawal", mgr(0))), OK);
  assert.equal(verdict(capability("cancelIntentOrder", mgr(0))), OK);
  // Never the owner's controls, even with every permission.
  for (const action of ["send", "updateRisk", "setAssetManager", "emergencyLock", "upgradeVault", "autoYield"]) {
    assert.equal(verdict(capability(action, mgr(all))), "owner_only", action);
  }
  // Under a lock a manager keeps exactly the owner's open set.
  assert.equal(verdict(capability("withdraw", mgr(all, 1))), OK);
  assert.equal(verdict(capability("deposit", mgr(all, 1))), T);
  assert.equal(verdict(capability("cancelIntentOrder", mgr(all, 2))), F);
});

test("a wallet with no role here may do nothing it would have to sign", () => {
  const none = { lockLevel: 0, role: "none" };
  assert.equal(verdict(capability("withdraw", none)), "no_permission");
  assert.equal(verdict(capability("send", none)), "owner_only");
});

test("from 1.0.6 the allow-list switch is frozen under either lock", () => {
  const owner = (lockLevel, vaultVersion) => ({ lockLevel, role: "owner", vaultVersion });
  assert.equal(verdict(capability("useBittyAllowList", owner(0, "1.0.6"))), OK);
  assert.equal(verdict(capability("useBittyAllowList", owner(1, "1.0.6"))), T);
  assert.equal(verdict(capability("useBittyAllowList", owner(2, "1.0.6"))), F);
  assert.equal(verdict(capability("useBittyAllowList", owner(1, "1.1.0"))), T);
  // An older vault, or one whose release is not known yet, keeps the way back to Bitty's list.
  assert.equal(verdict(capability("useBittyAllowList", owner(1, "1.0.5"))), OK);
  assert.equal(verdict(capability("useBittyAllowList", owner(2, null))), OK);
  // The rest of the open set is unchanged.
  for (const action of ["withdraw", "claimWithdrawal", "approveIntentSpender", "sendToWhitelistedRecipient"]) {
    assert.equal(verdict(capability(action, owner(2, "1.0.6"))), OK, action);
  }
});

test("from 1.0.6 a manager unwinds only with the permission that put it in", () => {
  const mgr = (permissions, lockLevel = 0) => ({ lockLevel, role: "assetManager", managerPermissions: permissions, vaultVersion: "1.0.6" });

  assert.equal(verdict(capability("withdraw", mgr(0))), "no_permission");
  assert.equal(verdict(capability("withdraw", mgr(PERM_SUPPLY))), OK);
  assert.equal(verdict(capability("withdraw", mgr(PERM_SUPPLY), { staking: true })), "no_permission");
  assert.equal(verdict(capability("withdraw", mgr(PERM_YIELD), { staking: true })), OK);
  assert.equal(verdict(capability("claimWithdrawal", mgr(PERM_MARKET_TRADE), { staking: true })), "no_permission");
  assert.equal(verdict(capability("claimWithdrawal", mgr(PERM_YIELD), { staking: true })), OK);
  assert.equal(verdict(capability("cancelIntentOrder", mgr(PERM_MARKET_TRADE))), "no_permission");
  assert.equal(verdict(capability("cancelIntentOrder", mgr(PERM_INTENT))), OK);
  assert.equal(verdict(capability("cancelIntentOrder", mgr(PERM_INTENT, 1))), T);
  // Still open under a lock, for a manager holding the bit.
  assert.equal(verdict(capability("withdraw", mgr(PERM_SUPPLY, 2))), OK);
  // The owner needs no bit.
  assert.equal(verdict(capability("withdraw", { lockLevel: 0, role: "owner", vaultVersion: "1.0.6" }, { staking: true })), OK);
});

test("from 1.0.7 a locked owner may sell a non-stablecoin into a stablecoin, and nothing else", () => {
  const owner = (lockLevel, extra = {}) => ({ lockLevel, role: "owner", vaultVersion: LOCKED_SALE_SINCE, ...extra });
  const intoStable = { sellsStablecoin: false, buysStablecoin: true };
  for (const level of [1, 2]) {
    const reason = level === 2 ? F : T;
    assert.equal(verdict(capability("marketTrade", owner(level), intoStable)), OK, `into a stablecoin at ${level}`);
    for (const legs of [
      { sellsStablecoin: true, buysStablecoin: true },
      { sellsStablecoin: true, buysStablecoin: false },
      { sellsStablecoin: false, buysStablecoin: false },
    ]) {
      assert.equal(verdict(capability("marketTrade", owner(level), legs)), "stablecoin_sale_only", JSON.stringify(legs));
    }
    // Legs not known yet (the last check before sending) read as allowed: the contract decides.
    assert.equal(verdict(capability("marketTrade", owner(level))), OK);
    assert.equal(verdict(capability("marketTrade", owner(level, { marketTradeOff: true }), intoStable)), "market_trade_off");
    // An older vault refuses every market trade under a lock.
    assert.equal(verdict(capability("marketTrade", owner(level, { vaultVersion: "1.0.6" }), intoStable)), reason);
  }
  assert.equal(verdict(capability("marketTrade", owner(0), { sellsStablecoin: true, buysStablecoin: true })), OK);
});

test("from 1.0.7 a lock leaves the manager nothing to do", () => {
  const all = PERM_YIELD | PERM_SUPPLY | PERM_MARKET_TRADE | PERM_INTENT;
  const mgr = (lockLevel, vaultVersion = LOCKED_SALE_SINCE) => ({
    lockLevel,
    role: "assetManager",
    managerPermissions: all,
    vaultVersion,
  });
  const intoStable = { sellsStablecoin: false, buysStablecoin: true };
  for (const action of ["withdraw", "claimWithdrawal", "approveIntentSpender", "deposit", "cancelIntentOrder"]) {
    assert.equal(verdict(capability(action, mgr(1))), T, action);
    assert.equal(verdict(capability(action, mgr(2))), F, action);
  }
  assert.equal(verdict(capability("marketTrade", mgr(1), intoStable)), T);
  assert.equal(verdict(capability("placeIntentOrder", mgr(2), { buysStablecoin: true })), F);
  assert.equal(verdict(capability("withdraw", mgr(0))), OK);
  assert.equal(verdict(capability("marketTrade", mgr(0))), OK);
  assert.equal(verdict(capability("withdraw", mgr(1, "1.0.6"))), OK);
});
