import type { RouteHandler, RouteParams } from "./context";

/**
 * A handler registered for a literal path, as a host or test double stores it.
 * The host calls it only with the params that path matched, which is what the
 * handler's narrower params type describes, so storing it unparameterised is safe.
 */
export function storedRouteHandler<Path extends string>(
  handler: RouteHandler<RouteParams<Path>>,
): RouteHandler {
  return handler as RouteHandler;
}
