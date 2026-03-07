import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, genericOAuth, twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { user as userTable } from "./db/schema";
import { sendMail } from "./utils/email";

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

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  secret,
  trustedOrigins: (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim()),
  appName: "OpenMapX",
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    async sendResetPassword({ user, url }) {
      await sendMail({
        to: user.email,
        subject: "Reset your password — OpenMapX",
        text: `Click the link below to reset your password:\n\n${url}\n\nIf you didn't request this, you can safely ignore this email.`,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    async sendVerificationEmail({ user, url }) {
      await sendMail({
        to: user.email,
        subject: "Verify your email — OpenMapX",
        text: `Welcome to OpenMapX! Please verify your email by clicking the link below:\n\n${url}`,
      });
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
  plugins: [
    passkey({
      rpID: process.env.PASSKEY_RP_ID ?? "localhost",
      rpName: "OpenMapX",
      origin: process.env.PASSKEY_ORIGIN ?? "http://localhost:3000",
    }),
    genericOAuth({
      config: [
        {
          providerId: "openstreetmap",
          discoveryUrl: "https://www.openstreetmap.org/.well-known/openid-configuration",
          clientId: process.env.OSM_CLIENT_ID ?? "",
          clientSecret: process.env.OSM_CLIENT_SECRET ?? "",
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
              email: `${osm.id}@users.openstreetmap.org`,
              emailVerified: false,
              image: osm.img?.href,
            };
          },
        },
        {
          providerId: "mapillary",
          authorizationUrl: "https://www.mapillary.com/connect",
          tokenUrl: "https://graph.mapillary.com/token",
          clientId: process.env.MAPILLARY_CLIENT_ID ?? "",
          clientSecret: process.env.MAPILLARY_CLIENT_SECRET ?? "",
          scopes: ["read"],
          async getToken({ code, redirectURI }) {
            const res = await fetch("https://graph.mapillary.com/token", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `OAuth ${process.env.MAPILLARY_CLIENT_SECRET ?? ""}`,
              },
              body: JSON.stringify({
                grant_type: "authorization_code",
                code,
                client_id: process.env.MAPILLARY_CLIENT_ID ?? "",
                redirect_uri: redirectURI,
              }),
            });
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
              email: `${data.id}@users.mapillary.com`,
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
          await sendMail({
            to: user.email,
            subject: "Your OpenMapX verification code",
            text: `Your verification code is: ${otp}\n\nThis code expires in 5 minutes.`,
          });
        },
      },
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        const subjects: Record<string, string> = {
          "sign-in": "Sign in to OpenMapX",
          "email-verification": "Verify your email — OpenMapX",
          "forget-password": "Reset your password — OpenMapX",
        };
        await sendMail({
          to: email,
          subject: subjects[type] ?? "OpenMapX verification code",
          text: `Your verification code is: ${otp}\n\nThis code expires in 5 minutes.`,
        });
      },
      changeEmail: {
        enabled: true,
      },
    }),
  ],
});
