// Generated with the web's src/lib/explainers.ts from one source: keep the two in step.

/**
 * Every explanation the ⓘ can open (components/Explain), with how many points it has. The text is
 * under `mobile.explain.<id>.title` and `.p1`…`.pN` (translations/mobile/explain.ts).
 */
export const EXPLAIN_POINTS = {
  timelock: 3,
  lock_levels: 4,
  fee_payer: 3,
  earned: 3,
  whitelist: 3,
  quantum: 4,
  security_level: 3,
  allowances: 3,
  transfer_ownership: 3,
  asset_manager: 3,
  recovery_phrase: 3,
  safe_vault: 3,
  apy: 3,
  lido_unstake: 3,
  auto_yield: 3,
  protocol_risk: 3,
  order_types: 4,
  slippage: 3,
  funding_from_positions: 3,
  vault_address: 3,
  allow_list: 3,
  overview_total: 3,
} as const;

export type ExplainId = keyof typeof EXPLAIN_POINTS;
