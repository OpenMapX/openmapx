/** Closed non-secret ownership projection carried by a configuration generation. */
import z from "zod/v4";
import { normalizeReleaseSelection } from "./release-selection";

export type PlatformField<T> = { source: "host" } | { source: "database"; value: T };
const field = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("host") }),
    z.strictObject({ source: z.literal("database"), value }),
  ]);
const domain = z
  .string()
  .max(253)
  .refine(
    (value) =>
      value === "localhost" ||
      value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)),
    "Expected a hostname without scheme, port or path",
  );
const email = z.email().max(320);
const releaseSelector = z
  .string()
  .max(128)
  .refine((value) => {
    try {
      normalizeReleaseSelection(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid release selector");
const region = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/);
const retention = z.number().int().min(1).max(36500);
export const platformConfigurationSchema = z.strictObject({
  version: z.literal(1),
  domain: field(domain).optional(),
  acmeEmail: field(email).optional(),
  releaseSelector: field(releaseSelector).optional(),
  defaultRegion: field(region).optional(),
  backupRetentionDays: field(retention).optional(),
});
export type PlatformConfiguration = z.infer<typeof platformConfigurationSchema>;
export type PlatformValues = {
  domain: string;
  acmeEmail: string;
  releaseSelector: string;
  defaultRegion: string | null;
  backupRetentionDays: number;
};
export function resolvePlatformConfiguration({
  saved,
  env = {},
  overrides = {},
}: {
  saved?: PlatformConfiguration;
  env?: Readonly<Record<string, string | undefined>>;
  overrides?: Partial<PlatformValues>;
}) {
  const ownership = saved ? platformConfigurationSchema.parse(saved) : undefined;
  const host: PlatformValues = {
    domain: env.DOMAIN || "localhost",
    acmeEmail: env.ACME_EMAIL || "admin@example.com",
    releaseSelector: env.OPENMAPX_RELEASE || "main",
    defaultRegion: env.OPENMAPX_REGION || null,
    backupRetentionDays: Number(env.BACKUP_RETENTION_DAYS || 30),
  };
  const values = { ...host };
  const sources = {} as Record<keyof PlatformValues, "host" | "database" | "invocation">;
  for (const key of Object.keys(host) as (keyof PlatformValues)[]) {
    const adopted = ownership?.[key];
    const value =
      overrides[key] !== undefined
        ? overrides[key]
        : adopted?.source === "database"
          ? adopted.value
          : host[key];
    sources[key] =
      overrides[key] !== undefined
        ? "invocation"
        : adopted?.source === "database"
          ? "database"
          : "host";
    // Validate only the effective value; an explicitly adopted field supersedes its host slot.
    const schema = {
      domain,
      acmeEmail: email,
      releaseSelector,
      defaultRegion: region.nullable(),
      backupRetentionDays: retention,
    }[key];
    Object.assign(values, { [key]: schema.parse(value) });
  }
  return { values, sources, warnings: [] as string[] };
}
