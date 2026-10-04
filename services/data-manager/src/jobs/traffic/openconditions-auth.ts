/**
 * The request headers of an OpenConditions read. With
 * `OPENCONDITIONS_OPERATOR_TOKEN` set, OpenConditions answers in operator scope
 * (restricted sources included); without it, in public scope.
 */
export function openConditionsHeaders(token: string | undefined): Record<string, string> {
  const value = token?.trim();
  return value ? { Authorization: `Bearer ${value}` } : {};
}
