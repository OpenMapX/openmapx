/** Presentation helpers over the canonical generated operation contracts. */
import { type ApiClient, ApiClientError } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type {
  AdminOperationContract,
  AdminOperationFormValue,
  AdminOperationInputError as InputErrorBody,
} from "@openmapx/core/api-contracts";
import { SERVICE_READ_TIMEOUT_MS, serviceErrorMessage } from "@/lib/admin/serviceAdmin";

export type {
  AdminOperationContract,
  AdminOperationField,
  AdminOperationPreview,
} from "@openmapx/core/api-contracts";
export type AdminOperationFormValues = Record<string, AdminOperationFormValue>;

/** Keeps validated field paths available to the form without a second wire DTO. */
export class AdminOperationInputError extends Error {
  constructor(
    message: string,
    readonly issues: InputErrorBody["issues"],
  ) {
    super(message);
    this.name = "AdminOperationInputError";
  }
}
function operationError(error: unknown): never {
  if (error instanceof ApiClientError && error.status === 400) {
    const body = sdk.adminOperationInputErrorSchema.safeParse(error.payload);
    if (body.success) throw new AdminOperationInputError(body.data.error, body.data.issues);
  }
  throw new Error(serviceErrorMessage(error, "Operation request failed"), { cause: error });
}
export async function previewAdminOperation(
  client: ApiClient,
  id: string,
  values: AdminOperationFormValues,
) {
  try {
    return sdk.unwrapAdminResponse(
      await sdk.previewAdminOperation(id, values, { client, timeoutMs: SERVICE_READ_TIMEOUT_MS }),
    );
  } catch (error) {
    return operationError(error);
  }
}
/** Queues raw form input; transformed preview input is never submitted as raw input. */
export async function runAdminOperation(
  client: ApiClient,
  id: string,
  values: AdminOperationFormValues,
): Promise<string> {
  try {
    return sdk.unwrapAdminResponse(await sdk.runAdminOperation(id, values, { client })).jobId;
  } catch (error) {
    return operationError(error);
  }
}
export function initialFormValues(contract: AdminOperationContract): AdminOperationFormValues {
  const values: AdminOperationFormValues = {};
  for (const field of contract.fields) {
    values[field.name] = contract.defaults[field.name] ?? (field.kind === "boolean" ? false : "");
  }
  return values;
}
