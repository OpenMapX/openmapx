import { z } from "zod";

export type ControlIssuer = "ops-agent" | "data-manager" | "host-cli";
export const executionRefSchema = z
  .strictObject({
    executor: z.enum(["ops-agent", "data-manager", "host-cli"]),
    principal: z.enum(["api", "data-manager", "host-cli"]),
    executionId: z.string(),
    operationKey: z.string().regex(/^opk1_[A-Za-z0-9_-]{16,64}$/),
    operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    deadlineAt: z.number().int().nonnegative().safe(),
  })
  .refine((x) =>
    x.executor === "ops-agent"
      ? /^job1_[A-Za-z0-9_-]{16,64}$/.test(x.executionId)
      : z.uuid().safeParse(x.executionId).success,
  );
export type ExecutionRef = z.infer<typeof executionRefSchema>;
