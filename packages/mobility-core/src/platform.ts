/**
 * Whether a departure's current platform differs from its planned one.
 * Sources can add a platform's sections once they know where the train stops:
 * KVB plans "10" and later gives "10 A-B". That narrows the plan rather than
 * moving the departure, so it is no change.
 */
export function platformChanged(planned: string | undefined, current: string | undefined): boolean {
  const from = planned?.trim();
  const to = current?.trim();
  if (!from || !to || from === to) return false;
  return !to.startsWith(`${from} `) && !from.startsWith(`${to} `);
}
