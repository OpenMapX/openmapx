// Internal mint registry shared only by the fixed API and role-signature verifiers.
// Deliberately absent from every package export.
export const verifiedParents = new WeakSet<object>();
