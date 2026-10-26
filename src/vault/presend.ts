import {parseAbi, type Address, type Hex} from 'viem';
import {publicClientFor, type Network} from '@/core/chain';
import {translate} from '@/i18n';
import {useLanguage} from '@/core/language-store';
import {ACTION_FOR_FUNCTION, capability, type LockLevel} from './capabilities';
import {vaultFunctionName} from './vault-abi';

/**
 * The last look before a vault write is signed: is the vault locked against it?
 *
 * Screens disable what the lock refuses (useCapability), but they read the lock when they come into
 * focus, and a lock made on another device a moment ago is exactly the case that matters. One read
 * here turns it into the sentence the screen would have shown, instead of a relay refusal.
 *
 * Only the lock is checked: it is the one gate that can change under a screen without the screen
 * knowing. A vault not activated yet, or a read that fails, sends the write unchecked, and the
 * contract decides as it always did.
 */

const LOCK_ABI = parseAbi(['function lockLevel() view returns (uint8)']);

/** Throws, with the reason in the user's language, when the vault's lock refuses one of `calls`. */
export async function assertVaultAccepts(vault: Address, network: Network, calls: readonly Hex[]): Promise<void> {
  const actions = calls.flatMap((data) => {
    const name = vaultFunctionName(data);
    const action = name ? ACTION_FOR_FUNCTION[name] : undefined;
    return action ? [action] : [];
  });
  if (actions.length === 0) return;

  let level: LockLevel;
  try {
    const raw = Number(await publicClientFor(network).readContract({address: vault, abi: LOCK_ABI, functionName: 'lockLevel'}));
    if (raw !== 0 && raw !== 1 && raw !== 2) return;
    level = raw;
  } catch {
    return;
  }

  for (const action of actions) {
    const gate = capability(action, {lockLevel: level, role: 'owner'});
    if (!gate.allowed) throw new Error(translate(useLanguage.getState().language, `vault.gate.${gate.reason}`));
  }
}
