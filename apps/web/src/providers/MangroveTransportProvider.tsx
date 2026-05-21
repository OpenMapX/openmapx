"use client";

import type { Review, ReviewAggregate } from "@integrations/reviews/types";
import { API_ENDPOINTS, apiClient, useSession } from "@openmapx/core";
import {
  type MangroveCurrentUser,
  MangroveProvider,
  type MangroveTransport,
} from "@openmapx/mangrove-react";
import type { ReactNode } from "react";
import { useMemo } from "react";

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
    if (!res.ok) throw new Error(await res.text());
  },
  async updateKeypairWraps(payload) {
    const res = await rawFetch(`${API_ENDPOINTS.reviewKeypair}/wraps`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(await res.text());
  },
  async deleteKeypairEnvelope() {
    const res = await rawFetch(API_ENDPOINTS.reviewKeypair, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
  },
  submitReview(payload) {
    return apiClient.post<{ id: string }>(API_ENDPOINTS.reviewSubmit, payload);
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
  const { data: session } = useSession();
  const currentUser = useMemo<MangroveCurrentUser | null>(() => {
    const id = session?.user?.id;
    if (!id) return null;
    return { id, nickname: session.user.name ?? null };
  }, [session?.user?.id, session?.user?.name]);

  return (
    <MangroveProvider
      transport={openMapxTransport}
      currentUser={currentUser}
      webauthnKeyName="OpenMapX — Mangrove Reviews"
    >
      {children}
    </MangroveProvider>
  );
}
