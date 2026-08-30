import { z } from "zod";

export const openMeteoVariables = [
  "pm10",
  "pm2_5",
  "carbon_monoxide",
  "nitrogen_dioxide",
  "sulphur_dioxide",
  "ozone",
  "european_aqi",
  "us_aqi",
] as const;

const nullableValue = z.number().finite().nonnegative().nullable();
const unitsSchema = z
  .object({
    time: z.string().min(1),
    interval: z.string().optional(),
    pm10: z.string().min(1),
    pm2_5: z.string().min(1),
    carbon_monoxide: z.string().min(1),
    nitrogen_dioxide: z.string().min(1),
    sulphur_dioxide: z.string().min(1),
    ozone: z.string().min(1),
    european_aqi: z.string().min(1),
    us_aqi: z.string().min(1),
  })
  .strict();

const currentSchema = z
  .object({
    time: z.string().min(1),
    interval: z.number().int().positive().optional(),
    pm10: nullableValue,
    pm2_5: nullableValue,
    carbon_monoxide: nullableValue,
    nitrogen_dioxide: nullableValue,
    sulphur_dioxide: nullableValue,
    ozone: nullableValue,
    european_aqi: nullableValue,
    us_aqi: nullableValue,
  })
  .strict();

const hourlySchema = z
  .object({
    time: z.array(z.string().min(1)).min(1).max(168),
    pm10: z.array(nullableValue).max(168),
    pm2_5: z.array(nullableValue).max(168),
    carbon_monoxide: z.array(nullableValue).max(168),
    nitrogen_dioxide: z.array(nullableValue).max(168),
    sulphur_dioxide: z.array(nullableValue).max(168),
    ozone: z.array(nullableValue).max(168),
    european_aqi: z.array(nullableValue).max(168),
    us_aqi: z.array(nullableValue).max(168),
  })
  .strict();

export const openMeteoAirQualityResponseSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    elevation: z.number().finite().optional(),
    generationtime_ms: z.number().finite().nonnegative().optional(),
    utc_offset_seconds: z.number().int().min(-86_400).max(86_400),
    timezone: z.string().min(1).max(128),
    timezone_abbreviation: z.string().min(1).max(32),
    current_units: unitsSchema,
    current: currentSchema,
    hourly_units: unitsSchema,
    hourly: hourlySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const length = value.hourly.time.length;
    for (const variable of openMeteoVariables) {
      if (value.hourly[variable].length !== length) {
        context.addIssue({
          code: "custom",
          path: ["hourly", variable],
          message: `${variable} length must match hourly.time`,
        });
      }
    }
    for (const variable of openMeteoVariables.slice(0, 6)) {
      const unit = value.hourly_units[variable];
      if (!/^(µg\/m³|μg\/m³|ug\/m3)$/.test(unit)) {
        context.addIssue({
          code: "custom",
          path: ["hourly_units", variable],
          message: `${variable} must use mass concentration units`,
        });
      }
    }
  });

export type OpenMeteoAirQualityResponse = z.infer<typeof openMeteoAirQualityResponseSchema>;
