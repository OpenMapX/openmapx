/** Fixed host-local template evidence. Not an HTTP operation or delegation edge. */
import { createHmac } from "node:crypto";
import { join } from "node:path";
import z from "zod/v4";
import type { InstallationState } from "./control-records";
import { AnchoredDirectory } from "./filesystem";
export const LOCAL_CREDENTIAL_TEMPLATE_KIND = "transit.credentials.template";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const localCredentialTemplateOperationSchema = z.strictObject({
  kind: z.literal(LOCAL_CREDENTIAL_TEMPLATE_KIND),
  catalogRevisionId: digest,
  outputPath: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        !value.includes("\\") &&
        value
          .split("/")
          .every(
            (part) =>
              part !== "" &&
              part !== "." &&
              part !== ".." &&
              ![...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
          ),
    ),
  fileMac: digest,
});
export const localCredentialTemplateReceiptSchema = z.strictObject({
  kind: z.literal("feed-credential-template-written"),
  fileMac: digest,
});
export function localCredentialTemplateFileMac(
  state: InstallationState,
  raw: unknown,
  contents?: string,
): string {
  const operation = localCredentialTemplateOperationSchema.parse(raw);
  if (state.fixedChildId || state.installation.role !== "host-cli")
    throw Error("Local host credential template required");
  let bytes: Buffer;
  if (contents !== undefined) {
    bytes = Buffer.from(contents, "utf8");
    if (bytes.length > 65537) throw Error("Credential template file exceeds budget");
  } else {
    const opened: AnchoredDirectory[] = [];
    try {
      let directory = new AnchoredDirectory(join(state.dataRoot, "../../.."));
      opened.push(directory);
      const parts = operation.outputPath.split("/"),
        file = parts.pop();
      if (!file) throw Error("Credential template file unavailable");
      for (const part of parts) {
        directory = directory.directory(part);
        opened.push(directory);
      }
      bytes = directory.read(file, 65537, true);
    } finally {
      for (const directory of opened.reverse()) directory.close();
    }
  }
  return createHmac("sha256", state.privateKey.export({ type: "pkcs8", format: "der" }))
    .update("openmapx-local-feed-credential-template-v1\0")
    .update(state.installation.installationId)
    .update("\0")
    .update(operation.catalogRevisionId)
    .update("\0")
    .update(operation.outputPath)
    .update("\0")
    .update(bytes)
    .digest("hex");
}
