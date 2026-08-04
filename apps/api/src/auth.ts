import { expo } from "@better-auth/expo";
import { i18n } from "@better-auth/i18n";
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, customSession, emailOTP, genericOAuth, twoFactor } from "better-auth/plugins";
import { emailHarmony } from "better-auth-harmony";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { user as userTable } from "./db/schema";
import { auditAdminActionsHook } from "./utils/auth-audit-hook";
import { sendMail } from "./utils/email";
import {
  emailOtpEmail,
  resetPasswordEmail,
  twoFactorOtpEmail,
  verifyEmailEmail,
} from "./utils/emailTemplates";
import { envString } from "./utils/env";
import { projectSessionPayload } from "./utils/session-projection";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET env var is required");

async function fetchProviderImage(
  providerId: string,
  accessToken: string,
): Promise<string | undefined> {
  try {
    if (providerId === "openstreetmap") {
      const res = await fetch("https://api.openstreetmap.org/api/0.6/user/details.json", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return undefined;
      const data = (await res.json()) as {
        user: { img?: { href: string } };
      };
      return data.user?.img?.href;
    }
    // Mapillary v4 API does not expose user profile pictures
  } catch {
    // Ignore fetch errors
  }
  return undefined;
}

const authOptions = {
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  baseURL: envString("BETTER_AUTH_URL", "http://localhost:3001"),
  secret,
  trustedOrigins: [
    ...envString("CORS_ORIGIN", "http://localhost:3000")
      .split(",")
      .map((o) => o.trim()),
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
  },
  databaseHooks: {
    account: {
      create: {
        after: async (account) => {
          if (account.providerId !== "openstreetmap" && account.providerId !== "mapillary") return;

          // Skip if user already has a profile picture (e.g. set by getUserInfo during sign-up)
          const [currentUser] = await db
            .select({ image: userTable.image })
            .from(userTable)
            .where(eq(userTable.id, account.userId));
          if (currentUser?.image) return;

          // Try to fetch a profile picture from the newly linked provider
          if (account.accessToken) {
            const imageUrl = await fetchProviderImage(account.providerId, account.accessToken);
            if (imageUrl) {
              await db
                .update(userTable)
                .set({ image: imageUrl })
                .where(eq(userTable.id, account.userId));
            }
          }
        },
      },
      update: {
        after: async (account) => {
          // On each OAuth sign-in, better-auth updates the account (access token refresh).
          // Re-fetch the profile picture to pick up changes (e.g. user changed OSM avatar).
          if (account.providerId !== "openstreetmap" && account.providerId !== "mapillary") return;

          if (!account.accessToken) return;

          const imageUrl = await fetchProviderImage(account.providerId, account.accessToken);

          // Update user image: set the new URL, or clear it if the provider no longer has one
          // (only clear if this provider was the source, i.e. no higher-priority provider has one)
          if (imageUrl) {
            await db
              .update(userTable)
              .set({ image: imageUrl })
              .where(eq(userTable.id, account.userId));
          } else if (account.providerId === "openstreetmap") {
            // OSM no longer has a picture — clear it
            await db.update(userTable).set({ image: null }).where(eq(userTable.id, account.userId));
          }
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
          discoveryUrl: "https://www.openstreetmap.org/.well-known/openid-configuration",
          clientId: envString("OSM_CLIENT_ID", ""),
          clientSecret: envString("OSM_CLIENT_SECRET", ""),
          scopes: ["openid", "read_prefs"],
          pkce: true,
          async getUserInfo({ accessToken }) {
            const res = await fetch("https://api.openstreetmap.org/api/0.6/user/details.json", {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!res.ok) throw new Error(`OSM user info fetch failed: ${res.status}`);
            const data = (await res.json()) as {
              user: { id: number; display_name: string; img?: { href: string } };
            };
            const osm = data.user;
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
            const res = await fetch("https://graph.mapillary.com/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `OAuth ${envString("MAPILLARY_CLIENT_SECRET", "")}`,
              },
              body: JSON.stringify({
                grant_type: "authorization_code",
                code,
                client_id: envString("MAPILLARY_CLIENT_ID", ""),
                redirect_uri: redirectURI,
              }),
            });
            if (!res.ok) {
              throw new Error(`Mapillary token exchange failed: ${res.status}`);
            }
            const data = (await res.json()) as {
              access_token: string;
              expires_in: number;
              token_type: string;
            };
            return {
              accessToken: data.access_token,
              tokenType: data.token_type,
              accessTokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
            };
          },
          async getUserInfo({ accessToken }) {
            const res = await fetch("https://graph.mapillary.com/me?fields=id,username", {
              headers: { Authorization: `OAuth ${accessToken}` },
            });
            if (!res.ok) throw new Error(`Mapillary user info fetch failed: ${res.status}`);
            const data = (await res.json()) as { id: string; username: string };
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
