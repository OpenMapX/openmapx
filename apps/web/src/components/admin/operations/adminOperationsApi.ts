/**
 * Client for the server-authored admin operation catalog. The API owns the
 * form contract, validation, preview text, and the effect; the browser only
 * renders what it is given and posts raw form values back.
 */

export type AdminOperationRisk = "normal" | "destructive";

export interface AdminOperationField {
  name: string;
  label: string;
  kind: "text" | "boolean" | "select";
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface AdminOperationConfirmation {
  title: string;
  message: string;
}

export type AdminOperationFormValue = string | boolean;
export type AdminOperationFormValues = Record<string, AdminOperationFormValue>;

export interface AdminOperationContract {
  id: string;
  version: number;
  group: "osm" | "build" | "overture" | "search" | "transit";
  title: string;
  description: string;
  risk: AdminOperationRisk;
  confirmation?: AdminOperationConfirmation;
  fields: readonly AdminOperationField[];
  defaults: Readonly<AdminOperationFormValues>;
}

export interface AdminOperationPreview {
  input: Record<string, unknown>;
  preview: string[];
  risk: AdminOperationRisk;
  confirmation?: AdminOperationConfirmation;
}

export interface AdminOperationIssue {
  path: string;
  message: string;
}

/** Thrown when the server rejects form values; carries per-field issues. */
export class AdminOperationInputError extends Error {
  readonly issues: AdminOperationIssue[];

  constructor(message: string, issues: AdminOperationIssue[]) {
    super(message);
    this.name = "AdminOperationInputError";
    this.issues = issues;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

function throwForFailure(
  response: Response,
  body: { error?: string; issues?: AdminOperationIssue[] },
  fallback: string,
): never {
  const message = body.error ?? fallback;
  if (response.status === 400 && Array.isArray(body.issues)) {
    throw new AdminOperationInputError(message, body.issues);
  }
  throw new Error(message);
}

export async function fetchAdminOperations(apiUrl: string): Promise<AdminOperationContract[]> {
  const response = await fetch(`${apiUrl}/api/admin/operations`, { credentials: "include" });
  const body = await readJson<{ operations?: AdminOperationContract[]; error?: string }>(response);
  if (!response.ok || !Array.isArray(body.operations)) {
    throw new Error(body.error ?? "Failed to load operations");
  }
  return body.operations;
}

export async function previewAdminOperation(
  apiUrl: string,
  id: string,
  values: AdminOperationFormValues,
): Promise<AdminOperationPreview> {
  const response = await fetch(`${apiUrl}/api/admin/operations/${encodeURIComponent(id)}/preview`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const body = await readJson<
    Partial<AdminOperationPreview> & {
      ok?: boolean;
      error?: string;
      issues?: AdminOperationIssue[];
    }
  >(response);
  if (!response.ok || body.ok !== true || !Array.isArray(body.preview)) {
    throwForFailure(response, body, "Failed to preview operation");
  }
  return {
    input: body.input ?? {},
    preview: body.preview,
    risk: body.risk ?? "normal",
    ...(body.confirmation ? { confirmation: body.confirmation } : {}),
  };
}

/** Queues the operation and resolves with the job id. */
export async function runAdminOperation(
  apiUrl: string,
  id: string,
  values: AdminOperationFormValues,
): Promise<string> {
  const response = await fetch(`${apiUrl}/api/admin/operations/${encodeURIComponent(id)}/run`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(values),
  });
  const body = await readJson<{
    ok?: boolean;
    jobId?: string;
    error?: string;
    issues?: AdminOperationIssue[];
  }>(response);
  if (!response.ok || !body.jobId) {
    throwForFailure(response, body, "Failed to queue operation");
  }
  return body.jobId;
}

export function initialFormValues(contract: AdminOperationContract): AdminOperationFormValues {
  const values: AdminOperationFormValues = {};
  for (const field of contract.fields) {
    const preset = contract.defaults[field.name];
    values[field.name] = preset ?? (field.kind === "boolean" ? false : "");
  }
  return values;
}
