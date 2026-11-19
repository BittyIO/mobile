/**
 * Messages thrown as errors that are not failures: a multisig owner's signature filed and waiting
 * for the other owners (vault/safe `SafeSignaturePending`). The write stops there on purpose, so
 * the toast shows it as done — green, with the message — rather than red.
 *
 * Kept by text because callers hand the toast `String(e)` or `e.message`, not the error itself.
 */
const soft = new Set<string>();

export function markSoft(message: string): void {
  soft.add(message);
}

/** Whether `detail` carries a soft message (it may be prefixed, as `String(e)` gives "Error: …"). */
export function softMessage(detail: string | undefined): string | null {
  if (!detail) return null;
  for (const m of soft) if (detail.includes(m)) return m;
  return null;
}
