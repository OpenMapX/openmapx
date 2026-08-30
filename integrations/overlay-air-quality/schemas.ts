import { z } from "zod";

const nullableDatetime = z
  .object({ utc: z.iso.datetime({ offset: true }), local: z.iso.datetime({ offset: true }) })
  .nullable();

const metaSchema = z.object({
  name: z.string().optional(),
  website: z.string().optional(),
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().default(100),
  found: z.union([z.number().int().nonnegative(), z.string(), z.null()]).optional(),
});

export const openAQParameterSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  units: z.string().min(1),
  displayName: z.string().nullable().optional(),
});

export const openAQLocationSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().nullable(),
  locality: z.string().nullable().optional(),
  timezone: z.string().min(1),
  country: z.object({
    id: z.number().int().nullable().optional(),
    code: z.string().min(2),
    name: z.string().min(1),
  }),
  owner: z.object({ id: z.number().int(), name: z.string().min(1) }),
  provider: z.object({ id: z.number().int(), name: z.string().min(1) }),
  isMobile: z.boolean(),
  isMonitor: z.boolean(),
  instruments: z.array(z.object({ id: z.number().int(), name: z.string().min(1) })),
  sensors: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      parameter: openAQParameterSchema,
    }),
  ),
  coordinates: z.object({
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
  }),
  licenses: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().min(1),
        attribution: z.object({ name: z.string().min(1), url: z.string().url().nullable() }),
        dateFrom: z.iso.date().nullable().optional(),
        dateTo: z.iso.date().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  distance: z.number().nonnegative().nullable().optional(),
  datetimeFirst: nullableDatetime.optional(),
  datetimeLast: nullableDatetime.optional(),
});

export const openAQLatestSchema = z.object({
  datetime: z.object({
    utc: z.iso.datetime({ offset: true }),
    local: z.iso.datetime({ offset: true }),
  }),
  value: z.number().finite(),
  coordinates: z.object({
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
  }),
  sensorsId: z.number().int().positive(),
  locationsId: z.number().int().positive(),
});

const coverageSchema = z.object({
  expectedCount: z.number().int().nonnegative(),
  expectedInterval: z.string(),
  observedCount: z.number().int().nonnegative(),
  observedInterval: z.string(),
  percentComplete: z.number().finite(),
  percentCoverage: z.number().finite(),
  datetimeFrom: nullableDatetime.optional(),
  datetimeTo: nullableDatetime.optional(),
});

export const openAQHourSchema = z.object({
  value: z.number().finite().nullable().optional(),
  flagInfo: z.object({ hasFlags: z.boolean() }),
  parameter: openAQParameterSchema,
  period: z
    .object({
      label: z.string(),
      interval: z.string(),
      datetimeFrom: nullableDatetime.optional(),
      datetimeTo: nullableDatetime.optional(),
    })
    .nullable()
    .optional(),
  coordinates: z
    .object({
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  coverage: coverageSchema.nullable().optional(),
  summary: z.unknown().nullable().optional(),
});

export const openAQLicenseSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  commercialUseAllowed: z.boolean(),
  attributionRequired: z.boolean(),
  shareAlikeRequired: z.boolean(),
  modificationAllowed: z.boolean(),
  redistributionAllowed: z.boolean(),
  sourceUrl: z.string().url(),
});

const defaultMeta = { page: 1, limit: 100 };
export const openAQLocationsResponseSchema = z.object({
  meta: metaSchema.default(defaultMeta),
  results: z.array(openAQLocationSchema),
});
export const openAQLatestResponseSchema = z.object({
  meta: metaSchema.default(defaultMeta),
  results: z.array(openAQLatestSchema),
});
export const openAQHoursResponseSchema = z.object({
  meta: metaSchema.default(defaultMeta),
  results: z.array(openAQHourSchema),
});
export const openAQLicensesResponseSchema = z.object({
  meta: metaSchema.default(defaultMeta),
  results: z.array(openAQLicenseSchema),
});

export type OpenAQParameter = z.infer<typeof openAQParameterSchema>;
export type OpenAQLocation = z.infer<typeof openAQLocationSchema>;
export type OpenAQLatest = z.infer<typeof openAQLatestSchema>;
export type OpenAQHour = z.infer<typeof openAQHourSchema>;
export type OpenAQLicense = z.infer<typeof openAQLicenseSchema>;
