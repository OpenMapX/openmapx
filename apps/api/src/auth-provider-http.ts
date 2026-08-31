import { fetchJson } from "@openmapx/core";
import { z } from "zod";

const AUTH_PROVIDER_TIMEOUT_MS = 8_000;
const AUTH_PROVIDER_MAX_BYTES = 256 * 1024;

export class AuthProviderRequestError extends Error {
  readonly code = "auth-provider-request-failed";

  constructor(readonly providerId: "openstreetmap" | "mapillary") {
    super("Authentication provider request failed");
    this.name = "AuthProviderRequestError";
  }
}

export interface AuthProviderRequestOptions {
  timeoutMs?: number;
}

const httpUrl = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  });

const osmDetailsSchema = z.object({
  user: z.object({
    id: z.number().int().nonnegative(),
    display_name: z.string().min(1).max(256),
    img: z.object({ href: httpUrl }).optional(),
  }),
});

const mapillaryTokenSchema = z.object({
  access_token: z.string().min(1).max(4_096),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(366 * 24 * 60 * 60),
  token_type: z.string().min(1).max(64),
});

const mapillaryUserSchema = z.object({
  id: z.string().min(1).max(256),
  username: z.string().min(1).max(256),
});

async function providerJson<T>(
  providerId: "openstreetmap" | "mapillary",
  schema: z.ZodType<T>,
  url: string,
  options: AuthProviderRequestOptions,
  init: Omit<RequestInit, "signal" | "headers"> & { headers?: Record<string, string> },
): Promise<T> {
  try {
    const { headers, ...requestInit } = init;
    const value = await fetchJson<unknown>(url, {
      timeoutMs: options.timeoutMs ?? AUTH_PROVIDER_TIMEOUT_MS,
      maxBytes: AUTH_PROVIDER_MAX_BYTES,
      label: "Authentication provider",
      headers,
      init: requestInit,
    });
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AuthProviderRequestError(providerId);
    return parsed.data;
  } catch {
    // Provider bodies, URLs and transport messages can contain credentials.
    // Better Auth receives one stable error and no nested cause to serialize.
    throw new AuthProviderRequestError(providerId);
  }
}

export async function fetchOsmUserDetails(
  url: string,
  accessToken: string | undefined,
  options: AuthProviderRequestOptions = {},
): Promise<z.infer<typeof osmDetailsSchema>["user"]> {
  if (!accessToken) throw new AuthProviderRequestError("openstreetmap");
  const data = await providerJson("openstreetmap", osmDetailsSchema, url, options, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data.user;
}

export async function exchangeMapillaryAuthorizationCode(
  input: { code: string; redirectUri: string; clientId: string; clientSecret: string },
  options: AuthProviderRequestOptions = {},
): Promise<{ accessToken: string; expiresInSeconds: number; tokenType: string }> {
  const data = await providerJson(
    "mapillary",
    mapillaryTokenSchema,
    "https://graph.mapillary.com/token",
    options,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `OAuth ${input.clientSecret}`,
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
      }),
    },
  );
  return {
    accessToken: data.access_token,
    expiresInSeconds: data.expires_in,
    tokenType: data.token_type,
  };
}

export async function fetchMapillaryUserInfo(
  accessToken: string | undefined,
  options: AuthProviderRequestOptions = {},
): Promise<{ id: string; username: string }> {
  if (!accessToken) throw new AuthProviderRequestError("mapillary");
  return providerJson(
    "mapillary",
    mapillaryUserSchema,
    "https://graph.mapillary.com/me?fields=id,username",
    options,
    { headers: { Authorization: `OAuth ${accessToken}` } },
  );
}
