// Intentionally empty. Lido on the vault is just a yield protocol — unstaking goes through the generic
// withdraw(protocol, asset, amount) the Earn per-position withdraw already relays. The async Lido claim
// is handled off the mobile client (keeper / web), so no Lido-specific client code is needed. Safe to
// delete this file.
export {};
