/**
 * Keeps a user's profile picture in sync with a linked OAuth provider.
 *
 * Extracted from `auth.ts` so the behavior is testable without a database and
 * so one rule is enforced in one place: the stored `account.accessToken` column
 * may hold ciphertext once `account.encryptOAuthTokens` is on, so the hooks
 * must resolve a usable token through Better Auth's public server API rather
 * than reading the column. Resolving can refresh and persist the account, which
 * fires the update hook again — hence the per-user/provider re-entry guard.
 */

/** Providers whose profile picture may become the OpenMapX avatar. */
export const AVATAR_PROVIDERS = ["openstreetmap", "mapillary"] as const;
export type AvatarProvider = (typeof AVATAR_PROVIDERS)[number];

export interface ProviderAvatarDeps {
  /** Resolve a usable (decrypted, refreshed) access token, or undefined. */
  resolveAccessToken(accountId: string, userId: string): Promise<string | undefined>;
  fetchProviderImage(providerId: string, accessToken: string): Promise<string | undefined>;
  getCurrentImage(userId: string): Promise<string | null | undefined>;
  setUserImage(userId: string, image: string | null): Promise<void>;
}

export interface ProviderAvatarSync {
  onAccountCreated(accountId: string, providerId: string, userId: string): Promise<void>;
  onAccountUpdated(accountId: string, providerId: string, userId: string): Promise<void>;
}

function isAvatarProvider(providerId: string): providerId is AvatarProvider {
  return (AVATAR_PROVIDERS as readonly string[]).includes(providerId);
}

export function createProviderAvatarSync(deps: ProviderAvatarDeps): ProviderAvatarSync {
  const inFlight = new Set<string>();

  async function withGuard(
    providerId: string,
    userId: string,
    run: () => Promise<void>,
  ): Promise<void> {
    // Escaped, never a literal control byte in source: a raw NUL here makes
    // git treat the file as binary and hides its diff from review.
    const key = `${userId}\u0000${providerId}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await run();
    } catch {
      // An avatar is cosmetic: a provider outage or revoked token must never
      // fail the sign-in or account-link request that triggered this hook.
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * `unavailable` (no usable token) is deliberately distinct from `absent`
   * (the provider answered and has no picture): only the latter may clear an
   * existing avatar.
   */
  async function resolveImage(
    accountId: string,
    providerId: string,
    userId: string,
  ): Promise<{ state: "unavailable" } | { state: "absent" } | { state: "found"; url: string }> {
    const accessToken = await deps.resolveAccessToken(accountId, userId);
    if (!accessToken) return { state: "unavailable" };
    const image = await deps.fetchProviderImage(providerId, accessToken);
    return image ? { state: "found", url: image } : { state: "absent" };
  }

  return {
    async onAccountCreated(accountId, providerId, userId) {
      if (!isAvatarProvider(providerId)) return;
      await withGuard(providerId, userId, async () => {
        // A picture set during sign-up (or by a higher-priority provider) wins.
        if (await deps.getCurrentImage(userId)) return;
        const image = await resolveImage(accountId, providerId, userId);
        if (image.state === "found") await deps.setUserImage(userId, image.url);
      });
    },

    async onAccountUpdated(accountId, providerId, userId) {
      if (!isAvatarProvider(providerId)) return;
      await withGuard(providerId, userId, async () => {
        const image = await resolveImage(accountId, providerId, userId);
        if (image.state === "found") {
          await deps.setUserImage(userId, image.url);
        } else if (image.state === "absent" && providerId === "openstreetmap") {
          // OSM was the source and no longer has a picture — clear it.
          await deps.setUserImage(userId, null);
        }
      });
    },
  };
}
