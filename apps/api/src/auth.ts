import { expo } from "@better-auth/expo";
import { i18n } from "@better-auth/i18n";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { envString } from "@openmapx/core/server-env";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  admin,
  customSession,
  emailOTP,
  genericOAuth,
  jwt,
  oneTimeToken,
  twoFactor,
} from "better-auth/plugins";
import { emailHarmony } from "better-auth-harmony";
import { eq } from "drizzle-orm";
import {
  exchangeMapillaryAuthorizationCode,
  fetchMapillaryUserInfo,
  fetchOsmUserDetails,
} from "./auth-provider-http";
import { db } from "./db";
import { user as userTable } from "./db/schema";
import { managedOAuthProviderOptions } from "./managed-oauth-provider";
import { userErasureHooks } from "./services/user-erasure";
import { auditAdminActionsHook } from "./utils/auth-audit-hook";
import { configuredTrustedWebOrigins } from "./utils/csrf.js";
import { sendMail } from "./utils/email";
import {
  emailOtpEmail,
  resetPasswordEmail,
  twoFactorOtpEmail,
  verifyEmailEmail,
} from "./utils/emailTemplates";
import { getOsmConfig } from "./utils/osm-config";
import { createProviderAvatarSync } from "./utils/provider-avatar";
import { projectSessionPayload } from "./utils/session-projection";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET env var is required");

async function fetchProviderImage(
  providerId: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    if (providerId === "openstreetmap") {
      const user = await fetchOsmUserDetails(
        getOsmConfig().apiUrl("api/0.6/user/details.json"),
        accessToken,
      );
      return user.img?.href;
    }
    // Mapillary v4 API does not expose user profile pictures
  } catch {
    // Ignore fetch errors
  }
  return undefined;
}

/**
 * Avatar sync for linked providers. The stored `account.accessToken` is
 * ciphertext once `account.encryptOAuthTokens` is on, so the usable token is
 * resolved through Better Auth's public server API instead of the column. That
 * call can refresh and persist the account, which re-enters the update hook —
 * the sync's own guard absorbs that.
 */
const providerAvatarSync = createProviderAvatarSync({
  async resolveAccessToken(accountId, userId) {
    try {
      const result = await auth.api.getAccessToken({ body: { accountId, userId } });
      return result.accessToken ?? undefined;
    } catch {
      // Revoked, unrefreshable, or undecryptable. The person simply relinks.
      return undefined;
    }
  },
  fetchProviderImage,
  async getCurrentImage(userId) {
    const [currentUser] = await db
      .select({ image: userTable.image })
      .from(userTable)
      .where(eq(userTable.id, userId));
    return currentUser?.image;
  },
  async setUserImage(userId, image) {
    await db.update(userTable).set({ image }).where(eq(userTable.id, userId));
  },
});

const authOptions = {
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  baseURL: envString("BETTER_AUTH_URL", "http://localhost:3001"),
  secret,
  trustedOrigins: [
    ...configuredTrustedWebOrigins(),
    "openmapx://",
    ...(process.env.NODE_ENV === "development"
      ? ["exp://", "exp://**", "exp://192.168.*.*:*/**"]
      : []),
  ],
  appName: "OpenMapX",
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    async sendResetPassword({ user, url }) {
      const mail = resetPasswordEmail(url);
      await sendMail({ to: user.email, ...mail });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      const mail = verifyEmailEmail(url);
      await sendMail({ to: user.email, ...mail });
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["openstreetmap", "mapillary"],
      allowDifferentEmails: true,
    },
    // Provider access/refresh tokens are encrypted at rest with the deployment
    // auth secret. Contribution editing stores elevated OSM write scopes on
    // this same account row, so a database disclosure must not hand out
    // usable write tokens. Nothing may read the column directly afterwards —
    // see `providerAvatarSync` and `OsmAccountService`.
    encryptOAuthTokens: true,
  },
  databaseHooks: {
    user: {
      delete: userErasureHooks,
    },
    account: {
      create: {
        after: async (account) => {
          await providerAvatarSync.onAccountCreated(account.id, account.providerId, account.userId);
        },
      },
      update: {
        after: async (account) => {
          // Better Auth updates the account on each OAuth sign-in and token
          // refresh; re-read the picture so a changed provider avatar follows.
          await providerAvatarSync.onAccountUpdated(account.id, account.providerId, account.userId);
        },
      },
    },
  },
  hooks: {
    after: auditAdminActionsHook,
  },
  plugins: [
    i18n({
      defaultLocale: "en",
      detection: ["cookie", "header"],
      localeCookie: "NEXT_LOCALE",
      translations: {
        de: {
          // Base error codes
          USER_NOT_FOUND: "Benutzer nicht gefunden",
          FAILED_TO_CREATE_USER: "Benutzer konnte nicht erstellt werden",
          FAILED_TO_CREATE_SESSION: "Sitzung konnte nicht erstellt werden",
          FAILED_TO_UPDATE_USER: "Benutzer konnte nicht aktualisiert werden",
          FAILED_TO_GET_SESSION: "Sitzung konnte nicht abgerufen werden",
          INVALID_PASSWORD: "Ungültiges Passwort",
          INVALID_EMAIL: "Ungültige E-Mail-Adresse",
          INVALID_EMAIL_OR_PASSWORD: "Ungültige E-Mail oder Passwort",
          INVALID_USER: "Ungültiger Benutzer",
          SOCIAL_ACCOUNT_ALREADY_LINKED: "Social-Konto ist bereits verknüpft",
          PROVIDER_NOT_FOUND: "Anbieter nicht gefunden",
          INVALID_TOKEN: "Ungültiger Token",
          TOKEN_EXPIRED: "Token abgelaufen",
          ID_TOKEN_NOT_SUPPORTED: "ID-Token wird nicht unterstützt",
          FAILED_TO_GET_USER_INFO: "Benutzerinformationen konnten nicht abgerufen werden",
          USER_EMAIL_NOT_FOUND: "E-Mail-Adresse des Benutzers nicht gefunden",
          EMAIL_NOT_VERIFIED: "E-Mail-Adresse nicht bestätigt",
          PASSWORD_TOO_SHORT: "Passwort zu kurz",
          PASSWORD_TOO_LONG: "Passwort zu lang",
          USER_ALREADY_EXISTS: "Benutzer existiert bereits.",
          USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
            "Benutzer existiert bereits. Verwenden Sie eine andere E-Mail-Adresse.",
          EMAIL_CAN_NOT_BE_UPDATED: "E-Mail-Adresse kann nicht geändert werden",
          CREDENTIAL_ACCOUNT_NOT_FOUND: "Anmeldekonto nicht gefunden",
          SESSION_EXPIRED: "Sitzung abgelaufen. Melden Sie sich erneut an.",
          FAILED_TO_UNLINK_LAST_ACCOUNT: "Letztes Konto kann nicht getrennt werden",
          ACCOUNT_NOT_FOUND: "Konto nicht gefunden",
          USER_ALREADY_HAS_PASSWORD:
            "Benutzer hat bereits ein Passwort. Geben Sie dieses an, um das Konto zu löschen.",
          EMAIL_ALREADY_VERIFIED: "E-Mail-Adresse ist bereits bestätigt",
          EMAIL_MISMATCH: "E-Mail-Adressen stimmen nicht überein",
          SESSION_NOT_FRESH: "Sitzung ist nicht aktuell",
          LINKED_ACCOUNT_ALREADY_EXISTS: "Verknüpftes Konto existiert bereits",
          PASSWORD_ALREADY_SET: "Benutzer hat bereits ein Passwort",
          VALIDATION_ERROR: "Validierungsfehler",
          MISSING_FIELD: "Feld ist erforderlich",

          // Email OTP
          OTP_EXPIRED: "Code abgelaufen",
          INVALID_OTP: "Ungültiger Code",
          TOO_MANY_ATTEMPTS: "Zu viele Versuche",

          // Two-factor
          OTP_NOT_ENABLED: "OTP nicht aktiviert",
          OTP_HAS_EXPIRED: "OTP ist abgelaufen",
          TOTP_NOT_ENABLED: "TOTP nicht aktiviert",
          TWO_FACTOR_NOT_ENABLED: "Zwei-Faktor-Authentifizierung ist nicht aktiviert",
          BACKUP_CODES_NOT_ENABLED: "Wiederherstellungscodes sind nicht aktiviert",
          INVALID_BACKUP_CODE: "Ungültiger Wiederherstellungscode",
          INVALID_CODE: "Ungültiger Code",
          TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE:
            "Zu viele Versuche. Bitte fordern Sie einen neuen Code an.",
          INVALID_TWO_FACTOR_COOKIE: "Ungültiges Zwei-Faktor-Cookie",

          // Admin
          YOU_CANNOT_BAN_YOURSELF: "Sie können sich nicht selbst sperren",
          BANNED_USER: "Sie wurden von dieser Anwendung gesperrt",

          // Generic OAuth
          SESSION_REQUIRED: "Sitzung ist erforderlich",
        },
      },
    }),
    admin(),
    // The one mechanism by which a session established in the system browser
    // becomes a session in the WebView. Two minutes and single-use because the
    // token is in flight across a custom-scheme callback the OS routes, and the
    // only legitimate holder redeems it immediately. Stored hashed so a database
    // read never yields a usable token.
    oneTimeToken({ expiresIn: 2, storeToken: "hashed" }),
    // Kept for server-side compatibility with Expo's redirect handling. No Expo
    // native auth client is initialised: native never holds a session.
    expo(),
    emailHarmony({ allowNormalizedSignin: true }),
    passkey({
      rpID: envString("PASSKEY_RP_ID", "localhost"),
      rpName: "OpenMapX",
      origin: process.env.PASSKEY_ORIGIN
        ? process.env.PASSKEY_ORIGIN.split(",").map((o) => o.trim())
        : ["http://localhost:3000"],
    }),
    genericOAuth({
      config: [
        {
          providerId: "openstreetmap",
          discoveryUrl: getOsmConfig().discoveryUrl,
          // Keep the account namespace and core OAuth endpoints available
          // when OSM discovery is temporarily unreachable. These values come
          // from the same deployment-validated OSM origin; profile identity is
          // still proven by the access token against OSM's user-details API.
          accountIssuer: new URL(getOsmConfig().webBase).origin,
          authorizationUrl: getOsmConfig().webUrl("oauth2/authorize"),
          tokenUrl: getOsmConfig().webUrl("oauth2/token"),
          // The profile comes from OSM's authenticated user-details endpoint,
          // not from Better Auth's local user mapping. Pin its immutable OSM
          // numeric ID explicitly so the 1.7 account subject cannot drift.
          accountSubject: ({ profile }) => String(profile.id),
          clientId: envString("OSM_CLIENT_ID", ""),
          clientSecret: envString("OSM_CLIENT_SECRET", ""),
          // Ordinary sign-in stays minimal. Contribution write scopes are
          // requested incrementally, only when someone starts contributing.
          scopes: ["openid", "read_prefs"],
          pkce: true,
          async getUserInfo({ accessToken }) {
            const osm = await fetchOsmUserDetails(
              getOsmConfig().apiUrl("api/0.6/user/details.json"),
              accessToken,
            );
            return {
              id: String(osm.id),
              name: osm.display_name,
              email: `${osm.id}@osm.invalid`,
              emailVerified: false,
              image: osm.img?.href,
            };
          },
        },
        {
          providerId: "mapillary",
          authorizationUrl: "https://www.mapillary.com/connect",
          tokenUrl: "https://graph.mapillary.com/token",
          clientId: envString("MAPILLARY_CLIENT_ID", ""),
          clientSecret: envString("MAPILLARY_CLIENT_SECRET", ""),
          scopes: ["read"],
          async getToken({ code, redirectURI }) {
            const token = await exchangeMapillaryAuthorizationCode({
              code,
              redirectUri: redirectURI,
              clientId: envString("MAPILLARY_CLIENT_ID", ""),
              clientSecret: envString("MAPILLARY_CLIENT_SECRET", ""),
            });
            return {
              accessToken: token.accessToken,
              tokenType: token.tokenType,
              accessTokenExpiresAt: new Date(Date.now() + token.expiresInSeconds * 1000),
            };
          },
          async getUserInfo({ accessToken }) {
            const data = await fetchMapillaryUserInfo(accessToken);
            return {
              id: data.id,
              name: data.username,
              email: `${data.id}@mapillary.invalid`,
              emailVerified: false,
            };
          },
        },
      ],
    }),
    twoFactor({
      issuer: "OpenMapX",
      otpOptions: {
        async sendOTP({ user, otp }) {
          const mail = twoFactorOtpEmail(otp);
          await sendMail({ to: user.email, ...mail });
        },
      },
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        const mail = emailOtpEmail(otp, type);
        await sendMail({ to: email, ...mail });
      },
      changeEmail: {
        enabled: true,
      },
    }),
    jwt(),
    oauthProvider(managedOAuthProviderOptions),
  ],
} satisfies BetterAuthOptions;

/**
 * better-auth's own session endpoint returns the full stored session row. That
 * row carries the session token, the client IP address and the user agent,
 * none of which any caller reads, and the token is the value the signed
 * session cookie is built from. `customSession` replaces the endpoint's
 * response with the projection below, so those fields never leave the server.
 *
 * The options object is handed to the plugin so it keeps inferring the fields
 * the enabled plugins add to the user and session models.
 */
export const auth = betterAuth({
  ...authOptions,
  plugins: [
    ...authOptions.plugins,
    customSession(
      async ({ user, session }) => projectSessionPayload({ user, session }),
      authOptions,
    ),
  ],
});
