/** Control record primitives; contains no admission or retirement constructors. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { type ControlExecutionOrigin, parseControlRootOperationKey } from "../ops/control-root-key";
import type { ControlIssuer } from "../ops/execution-identity";
import type { AnchoredDirectory } from "./filesystem";
import type { LeaseBackend } from "./target-lease";

declare const installationBrand: unique symbol;
export type ControlInstallation = Readonly<{
  role: ControlIssuer;
  [installationBrand]: true;
}>;
export interface InstallationState {
  fixedChildId?: string;
  fixedParentAssertion?: string;
  installation: ControlInstallation;
  privateRoot: AnchoredDirectory;
  dataRoot: string;
  registeredTargets: ReadonlySet<string>;
  /** Where this role claims targets: the agent's store, directly or through the agent. */
  leases: LeaseBackend;
}
export const controlOriginSchema = z
  .strictObject({
    version: z.literal(1),
    rootKey: z.string().max(69),
    issuer: z.enum(["ops-agent", "data-manager", "host-cli"]),
    notAfter: z.number().int().positive().safe(),
  })
  .refine((o) => {
    try {
      return parseControlRootOperationKey(o.rootKey).notAfter === o.notAfter;
    } catch {
      return false;
    }
  });
export function sameControlOrigin(
  a: ControlExecutionOrigin | undefined,
  b: ControlExecutionOrigin | undefined,
): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.version === b.version &&
        a.rootKey === b.rootKey &&
        a.issuer === b.issuer &&
        a.notAfter === b.notAfter;
}
export const uuid = z.uuid();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export function controlDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export const targetSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .min(1)
  .max(256)
  .refine(
    (x) => x.every((v, i) => i === 0 || (x[i - 1] ?? v) < v),
    "Targets must be sorted and unique",
  );
