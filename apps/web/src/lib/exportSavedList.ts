"use client";

import type { ExportFormat } from "@openmapx/core/saved-place-export";
import {
  exportSavedList as acquireSavedListExport,
  type OperationRequestOptions,
  unwrapSavedResponse,
} from "@openmapx/core/saved-places-sdk";

export type { ExportFormat } from "@openmapx/core/saved-place-export";
export { SAVED_EXPORT_FORMATS as EXPORT_FORMATS } from "@openmapx/core/saved-place-export";

/**
 * Fetch a saved list's export from the API (cookie-authenticated) and trigger a
 * browser download. `filename` is the user-facing download name. Throws on a
 * non-OK response so the caller can surface an error.
 */
export async function exportSavedList(
  listId: string,
  format: ExportFormat,
  filename: string,
  options: OperationRequestOptions = {},
): Promise<void> {
  const blob = unwrapSavedResponse(
    await acquireSavedListExport(
      listId,
      { format },
      { ...options, timeoutMs: options.timeoutMs ?? 60_000 },
    ),
  );
  const anchor = document.createElement("a");
  const href = URL.createObjectURL(blob);
  try {
    anchor.href = href;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(href);
  }
}
