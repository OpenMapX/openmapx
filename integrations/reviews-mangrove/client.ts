/**
 * HTTP client for the Mangrove.reviews API (api.mangrove.reviews + upload.mangrove.reviews).
 *
 * Endpoints documented at https://docs.mangrove.reviews/. CORS is fully open,
 * but we still route through our backend for consistency, Redis caching and
 * provider attribution.
 */

import { fetchJson, USER_AGENT } from "@openmapx/core";
import type { MangroveWireReviewsResponse, MangroveWireSubject } from "./types.js";

export const MANGROVE_API_URL = "https://api.mangrove.reviews";
export const MANGROVE_UPLOAD_URL = "https://upload.mangrove.reviews";
export const MANGROVE_FILES_URL = "https://files.mangrove.reviews";

const FETCH_TIMEOUT_MS = 8_000;

export async function mangroveGetReviews(
  sub: string,
  opts?: {
    limit?: number;
    offset?: number;
    issuers?: boolean;
    maresiSubjects?: boolean;
    latestEditsOnly?: boolean;
  },
): Promise<MangroveWireReviewsResponse> {
  const url = new URL(`${MANGROVE_API_URL}/reviews`);
  url.searchParams.set("sub", sub);
  if (opts?.limit !== undefined) url.searchParams.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) url.searchParams.set("offset", String(opts.offset));
  if (opts?.issuers) url.searchParams.set("issuers", "true");
  if (opts?.maresiSubjects) url.searchParams.set("maresi_subjects", "true");
  if (opts?.latestEditsOnly !== undefined) {
    url.searchParams.set("latest_edits_only", String(opts.latestEditsOnly));
  }

  return fetchJson<MangroveWireReviewsResponse>(url.toString(), {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { Accept: "application/json" },
    errorMessage: ({ status, statusText }) => `Mangrove getReviews failed: ${status} ${statusText}`,
  });
}

export async function mangroveGetSubject(sub: string): Promise<MangroveWireSubject> {
  const url = new URL(`${MANGROVE_API_URL}/subject/${encodeURIComponent(sub)}`);
  return fetchJson<MangroveWireSubject>(url.toString(), {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { Accept: "application/json" },
    errorMessage: ({ status, statusText }) => `Mangrove getSubject failed: ${status} ${statusText}`,
  });
}

/**
 * Submit a fully-formed signed JWT. Per spec, the JWT goes in the URL path.
 * The server returns `true` (literal JSON) on success.
 */
export async function mangroveSubmit(jwt: string): Promise<void> {
  const url = `${MANGROVE_API_URL}/submit/${jwt}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`Mangrove submit failed: ${res.status} ${res.statusText} ${body}`);
  }
  const payload = await res.json().catch(() => null);
  if (payload !== true) {
    throw new Error(`Mangrove submit returned unexpected body: ${JSON.stringify(payload)}`);
  }
}

/**
 * PUT multipart/form-data with field name `files` to upload.mangrove.reviews.
 * Returns the first image id from the JSON array response, already resolved to
 * an absolute files.mangrove.reviews URL.
 */
export async function mangroveUploadImage(blob: Blob, filename: string): Promise<string> {
  const form = new FormData();
  form.append("files", blob, filename);
  const res = await fetch(MANGROVE_UPLOAD_URL, {
    method: "PUT",
    body: form,
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Mangrove upload failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "string") {
    throw new Error("Mangrove upload returned unexpected response");
  }
  const id = data[0];
  return `${MANGROVE_FILES_URL}/${id}`;
}
