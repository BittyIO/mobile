import type {MobileTable} from './index';

// Vaults owned by a Safe: adding one, and the approvals screen where its owners co-sign. English
// only for now; every other language falls back to it (i18n `resolve`).
export const safe: MobileTable = {
  en: {
    add_safe_vault: 'Add a Safe vault',
    add_safe_title: 'Add a Safe vault',
    add_safe_intro:
      'A vault owned by a Safe multi-sig. This phone signs as one of the Safe\'s owners; when the Safe needs more than one signature, its other owners approve before anything runs.',
    safe_address: 'Safe address',
    add: 'Add',
    checking: 'Checking…',
    invalid_address: 'That is not an address.',
    not_found: 'There is no Safe at that address on this network.',
    unsupported: 'This Safe cannot own a vault yet ({{problems}}). Bitty supports Safe 1.3.0 and 1.4.1 with the default fallback handler.',
    no_owner_key:
      'None of this phone\'s keys is an owner of that Safe. Add {{address}} as an owner of the Safe first, then add it here.',
    not_owner: 'This phone\'s key {{address}} is no longer an owner of the Safe, so it cannot sign for this vault.',
    safe_badge: 'Safe {{threshold}} of {{owners}}',
    approvals: 'Safe approvals',
    approvals_sub: 'Requests waiting for the Safe\'s owners',
    none: 'Nothing is waiting for the Safe\'s owners.',
    signed: 'Signed {{have}} of {{need}}',
    you_signed: 'You have signed',
    expires: 'Valid until {{when}}',
    stale: 'Can no longer run: another request for this vault ran first, or this one already ran.',
    expired: 'Expired before enough owners signed.',
    sign: 'Sign',
    finish: 'Finish',
    waiting: 'Waiting for co-owners',
    signing: 'Signing',
    finishing: 'Finishing',
    finished: 'Done',
    kind_ForwardRequest: 'Vault operation',
    kind_Activation: 'Activate vault',
    kind_Order: 'Limit order',
    kind_TwapOrder: 'TWAP',
    kind_OrderCancellations: 'Cancel orders',
    pending_toast:
      'Signed and sent for approval: {{have}} of {{need}} signatures. It runs once the Safe\'s other owners sign — see Settings › Safe approvals.',
    twap_late: 'Parts whose time passed while waiting for signatures are skipped.',
    unknown_call: 'Unrecognised call {{selector}} — check it before signing',
  },
};
