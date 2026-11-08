import {
  concat,
  encodeAbiParameters,
  encodePacked,
  getContractAddress,
  keccak256,
  type Address,
} from 'viem';

/**
 * Local CREATE2 prediction of an owner's vault address — no RPC. Ported verbatim from
 * `web/src/utils/predict-vault.ts`; mirrors BittyV1VaultFactory._predict:
 *   salt      = keccak256(abi.encodePacked(owner))
 *   init code = ERC1967Proxy.creationCode ++ abi.encode(bootstrap, "")
 * The address is fixed by (factory, bootstrap, owner) and never moves when the vault implementation
 * upgrades. Keep ERC1967_PROXY_CREATION_CODE in sync with the web copy (they move together on a
 * solc/OZ bump).
 */
const ERC1967_PROXY_CREATION_CODE =
  '0x60806040526102a88038038061001481610168565b92833981016040828203126101645781516001600160a01b03811692909190838303610164576020810151906001600160401b03821161016457019281601f8501121561016457835161006e610069826101a1565b610168565b9481865260208601936020838301011161016457815f926020809301865e86010152823b15610152577f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc80546001600160a01b031916821790557fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b5f80a282511561013a575f8091610122945190845af43d15610132573d91610113610069846101a1565b9283523d5f602085013e6101bc565b505b604051608d908161021b8239f35b6060916101bc565b50505034156101245763b398979f60e01b5f5260045ffd5b634c9c8ce360e01b5f5260045260245ffd5b5f80fd5b6040519190601f01601f191682016001600160401b0381118382101761018d57604052565b634e487b7160e01b5f52604160045260245ffd5b6001600160401b03811161018d57601f01601f191660200190565b906101e057508051156101d157805190602001fd5b630a12f52160e11b5f5260045ffd5b81511580610211575b6101f1575090565b639996b31560e01b5f9081526001600160a01b0391909116600452602490fd5b50803b156101e956fe60806040525f8073ffffffffffffffffffffffffffffffffffffffff7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc5416368280378136915af43d5f803e156053573d5ff35b3d5ffdfea2646970667358221220de1b233acf70481b2e809efad06a20a037369f49ef8c2e88798363732c1a84c764736f6c63430008220033' as const;

/**
 * The code every Bitty vault runs at its own address: the runtime half of the proxy above (it
 * starts after the constructor's trailing INVALID). A contract with any other code is not a vault
 * the factory made, whatever it answers to `owner()`.
 */
export const ERC1967_PROXY_RUNTIME_CODE = `0x${ERC1967_PROXY_CREATION_CODE.slice(ERC1967_PROXY_CREATION_CODE.indexOf('fe60806040525f80') + 2)}` as const;

export function predictVaultAddress(
  owner: Address,
  factory: Address,
  bootstrap: Address,
): Address {
  const salt = keccak256(encodePacked(['address'], [owner]));
  const initCode = concat([
    ERC1967_PROXY_CREATION_CODE,
    encodeAbiParameters(
      [{type: 'address'}, {type: 'bytes'}],
      [bootstrap, '0x'],
    ),
  ]);
  return getContractAddress({
    opcode: 'CREATE2',
    from: factory,
    salt,
    bytecode: initCode,
  });
}
