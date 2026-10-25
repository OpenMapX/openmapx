/** Signed record primitives; contains no admission or retirement constructors. */
import { createHash, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { z } from "zod";
import { type ControlExecutionOrigin, parseControlRootOperationKey } from "../ops/control-root-key";
import type { ControlIssuer, ExecutionRef } from "../ops/execution-identity";
import { canonicalJson } from "../ops/fingerprint";
import type { AnchoredDirectory } from "./filesystem";

declare const installationBrand: unique symbol;
export type ControlInstallation = Readonly<{
  installationId: string;
  role: ControlIssuer;
  publicKey: string;
  [installationBrand]: true;
}>;
export interface InstallationState {
  fixedChildId?: string;
  fixedParentAssertion?: string;
  installation: ControlInstallation;
  privateKey: KeyObject;
  publicKeys: Record<ControlIssuer, string>;
  privateRoot: AnchoredDirectory;
  dataRoot: string;
  registeredTargets: ReadonlySet<string>;
  retentionJournal?: {
    prepare?(executions: readonly { execution: ExecutionRef; digest?: string }[]): Promise<void>;
    contained(execution: ExecutionRef, digest: string | undefined): boolean;
    retire(
      executions: readonly { execution: ExecutionRef; digest: string; terminalAt?: number }[],
      manifestDigest: string,
    ): Promise<void>;
  };
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
export function originRecordDomain(base: string, envelope: unknown): string {
  const version = (envelope as { payload?: { version?: number } } | null)?.payload?.version;
  return `${base}-v${version === 2 ? 2 : 1}`;
}
export function validateOriginRecord(value: {
  version?: number;
  origin?: ControlExecutionOrigin;
}): boolean {
  return value.version === 2 ? !!value.origin : value.origin === undefined;
}
export const uuid = z.uuid();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export function controlDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function signControl<T>(
  key: KeyObject,
  domain: string,
  payload: T,
): { payload: T; signature: string } {
  return {
    payload,
    signature: sign(null, Buffer.from(`${domain}\0${canonicalJson(payload)}`), key).toString(
      "base64url",
    ),
  };
}
export function verifyControl<T>(
  key: string,
  domain: string,
  envelope: unknown,
  schema: z.ZodType<T>,
): T {
  const e = z
    .strictObject({ payload: schema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) })
    .parse(envelope);
  const k = createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" });
  if (
    k.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      Buffer.from(`${domain}\0${canonicalJson(e.payload)}`),
      k,
      Buffer.from(e.signature, "base64url"),
    )
  )
    throw Error("Invalid control signature");
  return e.payload;
}

export const targetSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
  .min(1)
  .max(256)
  .refine(
    (x) => x.every((v, i) => i === 0 || (x[i - 1] ?? v) < v),
    "Targets must be sorted and unique",
  );
