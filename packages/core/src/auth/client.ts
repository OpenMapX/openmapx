import { passkeyClient } from "@better-auth/passkey/client";
import { emailOTPClient, genericOAuthClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const baseURL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001")
    : "http://127.0.0.1:3001";

export const authClient = createAuthClient({
  baseURL,
  basePath: "/api/auth",
  plugins: [passkeyClient(), genericOAuthClient(), twoFactorClient(), emailOTPClient()],
});

export type Session = typeof authClient.$Infer.Session;
export type User = Session["user"];
