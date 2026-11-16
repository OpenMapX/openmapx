import { genericOAuth } from "better-auth/plugins";

type GenericOAuthOptions = Parameters<typeof genericOAuth>[0];
type GenericOAuthPlugin = ReturnType<typeof genericOAuth>;
type AuthContext = Parameters<GenericOAuthPlugin["init"]>[0];
type Provider = AuthContext["socialProviders"][number];

interface Timing {
  /** Longest a caller waits for the first discovery before continuing without it. */
  discoveryTimeoutMs?: number;
  /** Pause between background attempts while discovery has not succeeded. */
  retryMs?: number;
  now?: () => number;
}

/**
 * `genericOAuth` fetches every provider's discovery document while an auth
 * instance initializes, without a deadline. This API builds an instance per
 * policy revision and per transactional operation, so that fetch sat on the
 * request path (inside an open transaction) and repeated for every one of them.
 *
 * The providers hold no database or per-instance state, so one set serves every
 * instance: discovery runs once per process, the first caller waits a bounded
 * time for it, and later attempts after a failure happen in the background.
 * Until discovery succeeds the providers work from their configured endpoints,
 * as they already did when discovery failed.
 */
export function shareGenericOAuthProviders(
  options: GenericOAuthOptions,
  { discoveryTimeoutMs = 5000, retryMs = 60000, now = Date.now }: Timing = {},
): GenericOAuthPlugin {
  const discovering = genericOAuth(options);
  const configured = genericOAuth({
    ...options,
    config: options.config.map(({ discoveryUrl: _, discoveryHeaders: __, ...config }) => config),
  });
  const ids = new Set<string>(options.config.map((config) => config.providerId));
  const discovered = options.config.filter((config) => config.discoveryUrl);
  const own = (providers: Provider[]) => providers.filter((provider) => ids.has(provider.id));
  const complete = (providers: Provider[]) =>
    discovered.every((config) =>
      providers.some((provider) => provider.id === config.providerId && provider.issuer),
    );

  let shared: Promise<Provider[]> | undefined,
    settled = discovered.length === 0,
    attempting = false,
    retryAt = 0;

  function discover(context: AuthContext): Promise<Provider[] | undefined> {
    attempting = true;
    return discovering
      .init(context)
      .then((result) => {
        const providers = own(result.context.socialProviders);
        if (!complete(providers)) return undefined;
        settled = true;
        shared = Promise.resolve(providers);
        return providers;
      })
      .catch(() => undefined)
      .finally(() => {
        attempting = false;
        retryAt = now() + retryMs;
      });
  }

  async function first(context: AuthContext): Promise<Provider[]> {
    if (settled) return own((await configured.init(context)).context.socialProviders);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const providers = await Promise.race([
      discover(context),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, discoveryTimeoutMs, undefined);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    return providers ?? own((await configured.init(context)).context.socialProviders);
  }

  return {
    ...discovering,
    init: async (context) => {
      if (!shared) {
        const building = first(context);
        shared = building;
        // A failed build must not be remembered as the shared provider set.
        building.catch(() => {
          if (shared === building) shared = undefined;
        });
      } else if (!settled && !attempting && now() >= retryAt) void discover(context);
      const providers = await shared;
      return {
        context: {
          socialProviders: providers.concat(context.socialProviders),
          genericOAuthPendingDiscovery: new Map(),
        },
      };
    },
  };
}
