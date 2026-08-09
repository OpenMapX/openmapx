"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEnv } from "@/lib/EnvProvider";

export type ProvisioningSecretState = "missing" | "consistent" | "conflict";

export interface ManagedDawarichProvisioningStatus {
  installed: boolean;
  selected: boolean;
  running: boolean;
  healthy: boolean;
  publicOrigin: string | null;
  oauthClient: {
    present: boolean;
    clientId: string | null;
    redirectUriMatches: boolean;
    settingsMatch: boolean;
    recoveryRequired: boolean;
  };
  secrets: {
    databasePassword: ProvisioningSecretState;
    secretKeyBase: ProvisioningSecretState;
    oidcClientSecret: ProvisioningSecretState;
  };
  configReady: boolean;
  readyToStart: boolean;
  needsApply: boolean;
}

export class DawarichProvisioningApiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DawarichProvisioningApiError";
  }
}

async function parseResponse(response: Response): Promise<ManagedDawarichProvisioningStatus> {
  const body = (await response.json().catch(() => ({}))) as {
    code?: unknown;
  } & Partial<ManagedDawarichProvisioningStatus>;
  if (!response.ok) {
    throw new DawarichProvisioningApiError(
      typeof body.code === "string" ? body.code : "DAWARICH_PROVISIONING_FAILED",
    );
  }
  return body as ManagedDawarichProvisioningStatus;
}

export function useDawarichProvisioning() {
  const apiUrl = useEnv().apiUrl;
  const queryClient = useQueryClient();
  const queryKey = ["admin", "dawarich"] as const;

  const statusQuery = useQuery<ManagedDawarichProvisioningStatus, DawarichProvisioningApiError>({
    queryKey,
    queryFn: async () =>
      parseResponse(
        await fetch(`${apiUrl}/api/admin/dawarich`, {
          credentials: "include",
          cache: "no-store",
        }),
      ),
    staleTime: 10_000,
  });

  const provision = useMutation<
    ManagedDawarichProvisioningStatus,
    DawarichProvisioningApiError,
    string | undefined
  >({
    mutationFn: async (publicHost) =>
      parseResponse(
        await fetch(`${apiUrl}/api/admin/dawarich/provision`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(publicHost ? { publicHost } : {}),
        }),
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKey, status);
      queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
    },
  });

  const rotate = useMutation<ManagedDawarichProvisioningStatus, DawarichProvisioningApiError>({
    mutationFn: async () =>
      parseResponse(
        await fetch(`${apiUrl}/api/admin/dawarich/rotate-oidc-secret`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmation: "ROTATE DAWARICH OIDC SECRET" }),
        }),
      ),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKey, status);
    },
  });

  return { statusQuery, provision, rotate };
}
