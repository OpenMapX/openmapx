"use client";

import type { Review, ReviewAggregate } from "@integrations/reviews/types";
import { API_ENDPOINTS, apiClient } from "@openmapx/core";
import {
  MangroveConflictError,
  type MangroveCurrentUser,
  MangroveProvider,
  MangroveSignerError,
  type MangroveTransport,
  type SignerTransport,
} from "@openmapx/mangrove-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useSettledSessionAuthority } from "./SessionAuthorityBoundary";

/**
 * Adapts OpenMapX's `apiClient` + `useSession` + the `@integrations/reviews`
 * domain types into the generic {@link MangroveTransport} contract that the
 * `@openmapx/mangrove-react` hooks consume. Centralizing the adapter here
 * keeps `mangrove-react` framework-neutral and publishable as-is.
 */

function apiBaseUrl(): string {
  if (typeof window !== "undefined") {
    return (
      process.env.NEXT_PUBLIC_API_URL ?? process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001"
    );
  }
  return "http://localhost:3001";
}

/**
 * `apiClient` doesn't surface raw `Response` (it always parses JSON), but the
 * `/keypair` endpoint can return 204 No Content and the `/keypair/wraps` PUT
 * has no JSON body. Use a thin raw fetch for those.
 */
async function rawFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, apiBaseUrl()).toString();
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
}

const openMapxTransport: MangroveTransport<Review, ReviewAggregate> = {
  async getKeypairEnvelope() {
    const res = await rawFetch(API_ENDPOINTS.reviewKeypair);
    if (res.status === 204) return { state: "uninitialized" };
    if (!res.ok) throw new Error(`Keypair fetch failed: ${res.status}`);
    const data = await res.json();
    return { ...data, state: "ready" };
  },
  async createKeypairEnvelope(payload) {
    const res = await rawFetch(API_ENDPOINTS.reviewKeypair, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) throw new MangroveConflictError();
    if (!res.ok) throw new Error("Review key creation failed.");
    return res.json();
  },
  async updateKeypairWraps(payload) {
    const res = await rawFetch(`${API_ENDPOINTS.reviewKeypair}/wraps`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) throw new MangroveConflictError();
    if (!res.ok) throw new Error("Review key update failed.");
    return res.json();
  },
  async deleteKeypairEnvelope(payload) {
    const res = await rawFetch(API_ENDPOINTS.reviewKeypair, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 409) throw new MangroveConflictError();
    if (!res.ok) throw new Error("Review key deletion failed.");
  },
  async submitReview(payload, options) {
    const res = await rawFetch(API_ENDPOINTS.reviewSubmit, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options?.signal,
    });
    if (!res.ok) throw new Error("Review submission failed. Please try again.");
    return res.json();
  },
  uploadReviewImage(payload) {
    return apiClient.post<{ src: string }>(API_ENDPOINTS.reviewImage, payload);
  },
  async fetchPlaceReviews(query) {
    const params: Record<string, string> = {
      lat: String(query.lat),
      lng: String(query.lng),
      name: query.name,
    };
    if (query.osmId) params.osmId = query.osmId;
    const data = await apiClient.get<{ reviews: Review[] }>(API_ENDPOINTS.reviews, params);
    return data.reviews;
  },
  async fetchPlaceReviewAggregate(query) {
    const params: Record<string, string> = {
      lat: String(query.lat),
      lng: String(query.lng),
      name: query.name,
    };
    if (query.osmId) params.osmId = query.osmId;
    const data = await apiClient.get<{ aggregate: ReviewAggregate }>(
      API_ENDPOINTS.reviewAggregate,
      params,
    );
    return data.aggregate;
  },
};

export function MangroveTransportProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSettledSessionAuthority();
  const currentUser = useMemo<MangroveCurrentUser | null>(() => {
    const id = session?.user?.id;
    if (!id) return null;
    return { id, nickname: session.user.name ?? null, authorityId: session.session?.id };
  }, [session?.user?.id, session?.user?.name, session?.session?.id]);

  const transport = useMemo(() => {
    const call = async <T,>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
      const res = await rawFetch(`/api/integrations/reviews-mangrove/signer/${path}`, {
        cache: "no-store",
        signal,
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...(body as object), expectedUserId: currentUser?.id }),
            }),
      });
      if (!res.ok) throw new MangroveSignerError(res.status);
      return res.json();
    };
    const signer: SignerTransport = {
      getConfig: (options) => call("config", undefined, options?.signal),
      getAccount: (sessionToken, options) => call("account", { sessionToken }, options?.signal),
      signReview: (sessionToken, review, options) =>
        call("sign", { sessionToken, review }, options?.signal),
      revokeSession: (sessionToken, options) => call("revoke", { sessionToken }, options?.signal),
    };
    return { ...openMapxTransport, signer };
  }, [currentUser?.id]);
  return (
    <MangroveProvider
      transport={transport}
      currentUser={currentUser}
      webauthnKeyName="OpenMapX — Mangrove Reviews"
    >
      {children}
    </MangroveProvider>
  );
}
