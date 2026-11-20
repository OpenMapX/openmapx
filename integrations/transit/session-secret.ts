/**
 * The host's session secret, which signs itinerary refresh and page tokens. This
 * is the only place the transit integration reads it from the environment.
 */
export function sessionSecret(): string {
  return process.env.BETTER_AUTH_SECRET ?? "";
}
