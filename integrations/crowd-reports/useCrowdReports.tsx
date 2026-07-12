"use client";

import { API_ENDPOINTS } from "@openmapx/core";
import {
  type DeviceKey,
  loadOrCreateDeviceKey,
  localStorageDeviceKeyStore,
  type ReportClaim,
  type SubClaimBody,
  signReport,
  signSubClaim,
} from "@openmapx/openconditions-contrib-client";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { generateNonce } from "./claim";
import type { SubClaimAction } from "./relay";

const GRANT_STORAGE_KEY = "openconditions.contrib.grant";
// Reporting grants live ~24h; treat a cached grant as expired after 23h so we
// re-enroll before the contributions-api would reject it, avoiding a failed
// submit on a stale grant.
const GRANT_TTL_MS = 23 * 60 * 60 * 1000;

interface CachedGrant {
  reportingGrant: unknown;
  issuedAt: number;
}

/** Entitlement returned by POST /contrib/enroll (relayed via /enroll). */
interface Entitlement {
  reportingGrant?: unknown;
  grantTokens?: unknown;
  trustSignal?: unknown;
  reason?: string;
}

function loadCachedGrant(): CachedGrant | null {
  try {
    const raw = globalThis.localStorage?.getItem(GRANT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedGrant;
    if (typeof parsed?.issuedAt !== "number" || parsed.reportingGrant == null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function storeGrant(reportingGrant: unknown): CachedGrant {
  const entry: CachedGrant = { reportingGrant, issuedAt: Date.now() };
  try {
    globalThis.localStorage?.setItem(GRANT_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Non-persistent storage is fine; the in-memory ref still carries the grant.
  }
  return entry;
}

function isFresh(entry: CachedGrant): boolean {
  return Date.now() - entry.issuedAt < GRANT_TTL_MS;
}

/**
 * The device-local, pseudonymous signing identity for crowd reports plus its
 * reporting entitlement. There is no login: `loadOrCreateDeviceKey` mints a
 * P-256 key on first use (private JWK persisted in localStorage, never
 * account-bound), and `ensureGrant` enrolls that key with the contributions-api
 * to obtain a `reportingGrant` — required to authorize every report/vote.
 *
 * A no-attestation device MUST still enroll (per the OpenConditions ADR): the
 * enroll body carries a minimal `DeviceProof` of just `{ keyId }`; hardware
 * attestation / OSM auth are optional and absent here. The grant is cached
 * device-locally and re-minted before it expires. (The Privacy Pass `/tokens`
 * flow is NOT used for reporting — reports are key-signed + grant-authorized,
 * not token-authorized — so it is intentionally not wired into this path.)
 */
export function useContributorSession() {
  const { apiUrl } = useEnv();
  const keyRef = useRef<DeviceKey | null>(null);
  const grantRef = useRef<CachedGrant | null>(null);
  const [keyId, setKeyId] = useState<string | null>(null);

  const ensureKey = useCallback(async (): Promise<DeviceKey> => {
    if (keyRef.current) return keyRef.current;
    const key = await loadOrCreateDeviceKey(localStorageDeviceKeyStore());
    keyRef.current = key;
    setKeyId(key.keyId);
    return key;
  }, []);

  const enroll = useCallback(
    async (key: DeviceKey): Promise<unknown> => {
      const res = await fetch(`${apiUrl}${API_ENDPOINTS.crowdReportsEnroll}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        // Minimal DeviceProof: pubJwk + keyId. No attestation/osmAuth — a
        // no-attestation device is still allowed to enroll.
        body: JSON.stringify({ pubJwk: key.publicJwk, proof: { keyId: key.keyId } }),
      });
      if (!res.ok) throw new Error(`Enroll failed: ${res.status}`);
      const entitlement = (await res.json()) as Entitlement;
      if (entitlement?.reportingGrant == null) {
        throw new Error("Enroll returned no reportingGrant");
      }
      const entry = storeGrant(entitlement.reportingGrant);
      grantRef.current = entry;
      return entry.reportingGrant;
    },
    [apiUrl],
  );

  const ensureGrant = useCallback(async (): Promise<unknown> => {
    if (grantRef.current && isFresh(grantRef.current)) return grantRef.current.reportingGrant;
    const cached = loadCachedGrant();
    if (cached && isFresh(cached)) {
      grantRef.current = cached;
      return cached.reportingGrant;
    }
    const key = await ensureKey();
    return enroll(key);
  }, [ensureKey, enroll]);

  return { ensureKey, ensureGrant, keyId };
}

/**
 * Submit a signed crowd report: enroll if needed for a fresh reporting grant,
 * sign the claim with the device key, then POST `{ report, reportingGrant }` to
 * the `crowd-reports` relay (which forwards it to the contributions-api). The
 * mutation input is the fully-built {@link ReportClaim} (see `buildReportClaim`).
 */
export function useSubmitReport() {
  const { apiUrl } = useEnv();
  const { ensureKey, ensureGrant } = useContributorSession();

  return useMutation({
    mutationFn: async (claim: ReportClaim): Promise<unknown> => {
      const key = await ensureKey();
      const reportingGrant = await ensureGrant();
      const report = await signReport(claim, key);
      const res = await fetch(`${apiUrl}${API_ENDPOINTS.crowdReportsSubmit}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({ report, reportingGrant }),
      });
      if (!res.ok) throw new Error(`Report submit failed: ${res.status}`);
      return res.json();
    },
  });
}

export interface VoteInput {
  /** The report/observation id used in the relay path (`/reports/:id/:action`). */
  reportId: string;
  /** The subject URI the sub-claim is about (report urn or observation id). */
  subject: string;
  action: SubClaimAction;
  /** Free text; only meaningful for `flag`. */
  reason?: string;
}

/**
 * Confirm / negate / flag an existing report or observation. Enrolls for a grant
 * if needed, signs a sub-claim (body WITHOUT the envelope fields) and POSTs
 * `{ subClaim, reportingGrant }` to `/reports/:id/:action`.
 */
export function useVote() {
  const { apiUrl } = useEnv();
  const { ensureKey, ensureGrant } = useContributorSession();

  return useMutation({
    mutationFn: async ({ reportId, subject, action, reason }: VoteInput): Promise<unknown> => {
      const key = await ensureKey();
      const reportingGrant = await ensureGrant();
      const body: SubClaimBody = {
        subject,
        claimType: action,
        reportedAt: new Date().toISOString(),
        nonce: generateNonce(),
        ...(reason ? { reason } : {}),
      };
      const subClaim = await signSubClaim(body, key);
      const url = `${apiUrl}${API_ENDPOINTS.crowdReportsVote}/${encodeURIComponent(reportId)}/${action}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({ subClaim, reportingGrant }),
      });
      if (!res.ok) throw new Error(`Vote failed: ${res.status}`);
      return res.json();
    },
  });
}
