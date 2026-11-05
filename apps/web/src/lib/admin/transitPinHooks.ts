"use client";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { createControlRootOperationKey } from "@openmapx/core/ops/control-root-key";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useAccountAdmin } from "./accountAdmin";
import { browserAdminApiBase } from "./browserAdminApiBase";

function useScope() {
  const { apiUrl, actorId } = useAccountAdmin();
  const client = useMemo(
    () => createApiClient({ baseUrl: browserAdminApiBase(apiUrl), credentials: "include" }),
    [apiUrl],
  );
  return { apiUrl, actorId, client };
}
export function useTransitPins(query: {
  proposalId?: string;
  offset?: number;
  diffOffset?: number;
}) {
  const { apiUrl, actorId, client } = useScope();
  return useQuery({
    queryKey: [
      "admin",
      "transit",
      "pins",
      apiUrl,
      actorId,
      query.proposalId ?? null,
      query.offset ?? 0,
      query.diffOffset ?? 0,
    ],
    enabled: Boolean(actorId),
    gcTime: 0,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(await sdk.getAdminTransitPins(query, { client, signal })),
    refetchInterval: (current) =>
      current.state.data?.execution &&
      ["queued", "running", "cancel_pending"].includes(current.state.data.execution.status)
        ? 5000
        : 60000,
  });
}
function useCatalogAction<Input, Output>(
  budgetMs: number,
  execute: (
    input: Input,
    key: string,
    options: { client: ReturnType<typeof createApiClient>; signal: AbortSignal },
  ) => Promise<Output>,
) {
  const { apiUrl, actorId, client } = useScope(),
    qc = useQueryClient();
  const identities = useRef(new Map<string, string>()),
    observers = useRef(new Set<AbortController>());
  useEffect(
    () => () => {
      for (const observer of observers.current) observer.abort();
    },
    [],
  );
  return useMutation({
    retry: false,
    gcTime: 0,
    mutationFn: async (input: Input) => {
      if (!actorId) throw Error("Administrator session required");
      const address = JSON.stringify([apiUrl, actorId, input]),
        controller = new AbortController();
      const key =
        identities.current.get(address) ??
        createControlRootOperationKey({
          notAfter: Date.now() + budgetMs,
          nonce: crypto.getRandomValues(new Uint8Array(16)),
        });
      identities.current.set(address, key);
      observers.current.add(controller);
      try {
        const value = await execute(input, key, { client, signal: controller.signal });
        identities.current.delete(address);
        return { value, apiUrl, actorId };
      } finally {
        observers.current.delete(controller);
      }
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({
        queryKey: ["admin", "transit", "pins", result.apiUrl, result.actorId],
      });
    },
  });
}
export function useProposeTransitPins() {
  return useCatalogAction(3600000, async (input: { branch: string }, key, options) =>
    sdk.unwrapAdminResponse(
      await sdk.proposeAdminTransitPins(input, { "idempotency-key": key }, options),
    ),
  );
}
export function useValidateTransitPins() {
  return useCatalogAction(
    72 * 3600000,
    async (input: { proposalId: string; countries: string[] }, key, options) =>
      sdk.unwrapAdminResponse(
        await sdk.validateAdminTransitPins(
          input.proposalId,
          { countries: input.countries },
          { "idempotency-key": key },
          options,
        ),
      ),
  );
}
export function useActivateTransitPins() {
  type Input = {
    proposalId: string;
    validationId: string;
    expectedGenerationId: string | null;
    diffDigest: string;
    acknowledgeLicenseChanges: boolean;
  };
  return useCatalogAction(3600000, async (input: Input, key, options) => {
    const { proposalId, ...body } = input;
    return sdk.unwrapAdminResponse(
      await sdk.activateAdminTransitPins(proposalId, body, { "idempotency-key": key }, options),
    );
  });
}
export function useCancelTransitPinExecution() {
  return useCatalogAction(
    120000,
    async (input: { id: string; operationKey: string; fingerprint: string }, _key, options) => {
      const { id, ...body } = input;
      return sdk.unwrapAdminResponse(await sdk.cancelAdminTransitPinExecution(id, body, options));
    },
  );
}
export function transitPinExecutionPending(
  value: { status: string; publication: string } | null | undefined,
): boolean {
  return Boolean(
    value &&
      (["queued", "running", "cancel_pending"].includes(value.status) ||
        value.publication === "unknown"),
  );
}
export function useTransitPinExecution(id: string | null) {
  const { apiUrl, actorId, client } = useScope(),
    qc = useQueryClient(),
    completed = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ["admin", "transit", "pin-execution", apiUrl, actorId, id],
    enabled: Boolean(actorId && id),
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!id) throw Error("Catalog execution required");
      return sdk.unwrapAdminResponse(await sdk.getAdminTransitPinExecution(id, { client, signal }));
    },
    refetchInterval: (current) =>
      !current.state.data || transitPinExecutionPending(current.state.data) ? 5000 : false,
  });
  useEffect(() => {
    const value = query.data;
    if (!value || transitPinExecutionPending(value)) return;
    const key = `${value.id}:${value.fingerprint}:${value.status}`;
    if (completed.current === key) return;
    completed.current = key;
    void qc.invalidateQueries({ queryKey: ["admin", "transit", "pins", apiUrl, actorId] });
  }, [query.data, apiUrl, actorId, qc]);
  return query;
}
