import {create} from 'zustand';
import {MMKV} from 'react-native-mmkv';

/**
 * Whether a vault upgrades itself — and each of its protocols — on the way to the next operation.
 *
 * ON by default. A new vault or adapter release is how fixes reach a vault, and asking the owner to
 * find the Upgrade row on a settings page meant most vaults stayed on whatever they were born on.
 * With these on, the next on-chain write that would run anyway carries the upgrade in front of it,
 * in the same multicall (see vault/auto-upgrade).
 *
 * Per network and vault, as every other vault setting is. A protocol is keyed by its LINEAGE — the
 * identity every build of an adapter shares — so the choice survives the protocol's own upgrades.
 */
const store = new MMKV({id: 'bitty.auto-upgrade'});

const scope = (network: string, vault: string) => `${network}:${vault.toLowerCase()}`;
const vaultKey = (network: string, vault: string) => `${scope(network, vault)}:vault`;
const protocolKey = (network: string, vault: string, lineage: string) => `${scope(network, vault)}:p:${lineage.toLowerCase()}`;

/** Bumped on every change, so a screen reading through the functions below redraws. */
export const useAutoUpgradeVersion = create<{v: number}>(() => ({v: 0}));
const bump = () => useAutoUpgradeVersion.setState((s) => ({v: s.v + 1}));

export function autoUpgradeVault(network: string, vault: string): boolean {
  return store.getBoolean(vaultKey(network, vault)) ?? true;
}

export function setAutoUpgradeVault(network: string, vault: string, on: boolean): void {
  store.set(vaultKey(network, vault), on);
  bump();
}

export function autoUpgradeProtocol(network: string, vault: string, lineage: string): boolean {
  return store.getBoolean(protocolKey(network, vault, lineage)) ?? true;
}

export function setAutoUpgradeProtocol(network: string, vault: string, lineage: string, on: boolean): void {
  store.set(protocolKey(network, vault, lineage), on);
  bump();
}
