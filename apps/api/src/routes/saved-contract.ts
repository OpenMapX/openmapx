import { savedOperations } from "@openmapx/core/api-contracts";
import type z from "zod/v4";
import { createContractRouteRegistrar } from "./contract-route";

const validationErrorMessage = (part: string, error: z.ZodError) =>
  error.issues.some((issue) => issue.path.includes("fieldContributors"))
    ? "Invalid fieldContributors"
    : `Invalid saved ${part}`;

export const registerSavedRoute = createContractRouteRegistrar(savedOperations, {
  validationErrorMessage,
  tag: "saved-places",
  schemaPrefix: "Saved",
  reuseSchemas: true,
  label: "saved",
  validationPhase: "preHandler",
});
export const registerSavedImportRoute = createContractRouteRegistrar(savedOperations, {
  validationErrorMessage,
  tag: "saved-places",
  schemaPrefix: "Saved",
  reuseSchemas: true,
  label: "saved",
  validationPhase: "preHandler",
  bodyLimit: 40 * 1024 * 1024,
});
