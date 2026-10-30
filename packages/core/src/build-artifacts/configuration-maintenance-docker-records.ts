/** Fixed private Docker observation data; parsing grants no authority. */
import { z } from "zod";

const string = z.string().max(65536),
  mount = z.object({
    Type: z.enum(["bind", "volume", "tmpfs"]),
    Source: string.optional(),
    Name: string.optional(),
    Destination: string,
    RW: z.boolean(),
  });
const normalizedMemory = z.union([
    z.number().int().nonnegative().safe(),
    z.string().max(16).regex(/^\d+$/),
  ]),
  normalizedCpu = z.union([
    z.number().finite().nonnegative().max(4096),
    z
      .string()
      .max(32)
      .regex(/^\d+(?:\.\d+)?$/),
  ]);
export const maintenanceDockerResourceSpecSchema = z.object({
  mem_limit: normalizedMemory.optional(),
  cpus: normalizedCpu.optional(),
  deploy: z
    .object({
      resources: z
        .object({
          limits: z
            .object({ memory: normalizedMemory.optional(), cpus: normalizedCpu.optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
export const maintenanceDockerHostResourcesSchema = z.object({
  Memory: z.number().int().nonnegative().safe(),
  NanoCpus: z.number().int().nonnegative().safe(),
  CpuQuota: z.number().int().min(-1).safe().default(0),
  CpuPeriod: z.number().int().nonnegative().safe().default(0),
});
export const maintenanceDockerContainerSchema = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  HostConfig: maintenanceDockerHostResourcesSchema,
  State: z.object({
    Status: z.string(),
    Running: z.boolean(),
    Health: z.object({ Status: z.string() }).optional(),
  }),
  Config: z.object({
    Image: string,
    Labels: z.record(z.string(), string),
    Env: z.array(string).max(1024),
  }),
  Mounts: z.array(mount).max(512),
});
const service = z.object({
  ...maintenanceDockerResourceSpecSchema.shape,
  image: string,
  environment: z
    .record(z.string(), z.union([string, z.number(), z.boolean(), z.null()]))
    .default({}),
  volumes: z
    .array(
      z.object({
        type: z.enum(["bind", "volume", "tmpfs"]),
        source: string.optional(),
        target: string,
        read_only: z.boolean().optional(),
      }),
    )
    .max(256)
    .default([]),
  secrets: z
    .array(z.object({ source: string, target: string.optional() }))
    .max(128)
    .default([]),
  healthcheck: z.object({ disable: z.boolean().optional() }).optional(),
});
export const maintenanceDockerComposeSchema = z.object({
  services: z.record(z.string(), service),
  secrets: z.record(z.string(), z.object({ file: string.optional() })).default({}),
  volumes: z.record(z.string(), z.object({ name: string.optional() })).default({}),
});
