"use client";
import { authClient, createApiClient } from "@openmapx/core";
import * as accountSdk from "@openmapx/core/api-admin-sdk";
import {
  type AdminReauthProofRef,
  type AuthPolicySettings,
  accountDeliverySchema,
  accountProvisioningResultSchema,
  accountRoleChangeSchema,
  assistedAccountPasswordSchema,
  assistedAccountVerifySchema,
  authPolicyViewSchema,
} from "@openmapx/core/api-contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { browserAdminApiBase } from "./browserAdminApiBase";

const messages: Record<string, string> = {
  ACCOUNT_MAIL_RATE_LIMITED: "Too many mail requests. Wait an hour before requesting another.",
  ACCOUNT_EMAIL_CHANGED: "This account's email changed. Refresh and confirm its current address.",
  ACCOUNT_ACTION_CONFLICT: "This request changed. Refresh before trying again.",
  REAUTHENTICATION_REQUIRED: "Confirm a fresh administrator sign-in for this action.",
  AUTH_POLICY_CONFLICT: "The active policy changed. Reload before applying your changes.",
  ADMIN_OPERATION_IN_PROGRESS:
    "Finish or cancel this administrator’s instance operations in Activity before deleting the account.",
  LAST_ADMIN_REQUIRED: "At least one active administrator must remain.",
  ROLE_VERSION_CONFLICT: "This account changed. Refresh before changing its role.",
  INVALID_PASSWORD: "The password does not meet the instance policy.",
  PASSWORD_TOO_SHORT: "The password does not meet the instance policy.",
  PASSWORD_TOO_LONG: "The password exceeds the instance limit.",
  UNAUTHORIZED: "Sign in again before managing accounts.",
  FORBIDDEN: "You do not have permission to perform this account action.",
  USER_ALREADY_EXISTS: "An account with this email already exists.",
};
export class AccountAdminError extends Error {
  readonly code: string;
  constructor(code: unknown) {
    const safe =
      typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "ACCOUNT_REQUEST_FAILED";
    super(messages[safe] ?? "The account request failed. Please try again.");
    this.name = "AccountAdminError";
    this.code = safe;
  }
}
export function unwrapAuthResult<T>(result: {
  data: T | null;
  error: { code?: unknown; message?: unknown; status?: number } | null;
}): T {
  if (result.error || result.data === null || result.data === undefined)
    throw new AccountAdminError(result.error?.code);
  return result.data;
}
export function accountError(error: unknown) {
  if (error instanceof AccountAdminError) return error;
  return new AccountAdminError(
    (error as { code?: unknown; payload?: { code?: unknown } } | null)?.code ??
      (error as { payload?: { code?: unknown } } | null)?.payload?.code,
  );
}
export type AccountRecoveryAction =
  | "invitation"
  | "verification-email"
  | "verify"
  | "reset-password"
  | "password";
function accountResponse(result: { status: number; data: unknown }) {
  if (result.status !== 200 || !result.data)
    throw new AccountAdminError((result.data as { error?: unknown } | null)?.error);
  return result.data;
}
/** Capture the actual auth methods and origin once; an in-flight request never follows a replacement client. */
export function createAccountAdminClient(apiUrl: string) {
  const admin = authClient.admin,
    baseURL = browserAdminApiBase(apiUrl),
    client = createApiClient({ baseUrl: baseURL, credentials: "include" });
  const fetchOptions = (headers?: Record<string, string>) => ({
    baseURL: `${baseURL}/api/auth`,
    credentials: "include" as const,
    ...(headers ? { headers } : {}),
  });
  const writes = (extra?: Record<string, string>) =>
    fetchOptions({ "Idempotency-Key": crypto.randomUUID(), ...extra });
  const list = async (query: NonNullable<Parameters<typeof admin.listUsers>[0]>["query"]) =>
    unwrapAuthResult(await admin.listUsers({ query, fetchOptions: fetchOptions() }));
  return {
    list,
    async get(id: string) {
      return (
        (await list({ filterField: "id", filterValue: id, filterOperator: "eq", limit: 1 }))
          .users[0] ?? null
      );
    },
    async count() {
      const data = await list({
        filterField: "role",
        filterValue: "admin",
        filterOperator: "eq",
        limit: 1,
      });
      return data.total ?? data.users.length;
    },
    async sessions(userId: string) {
      return unwrapAuthResult(
        await admin.listUserSessions({ userId, fetchOptions: fetchOptions() }),
      ).sessions;
    },
    async create(
      input: Parameters<typeof accountSdk.createAdminAccount>[0],
      key = crypto.randomUUID(),
    ) {
      return accountProvisioningResultSchema.parse(
        accountResponse(
          await accountSdk.createAdminAccount(input, { "idempotency-key": key }, { client }),
        ),
      );
    },
    async delivery(userId: string) {
      return accountDeliverySchema.parse(
        accountResponse(await accountSdk.getAdminAccountDelivery(userId, { client })),
      );
    },
    async policy() {
      return authPolicyViewSchema.parse(
        accountResponse(await accountSdk.getAdminAuthPolicy({ client })),
      );
    },
    async applyPolicy(settings: AuthPolicySettings, expectedRevision: string, key: string) {
      accountResponse(
        await accountSdk.applyAdminAuthPolicy(
          { settings, expectedRevision, confirmed: true, idempotencyKey: key },
          { client },
        ),
      );
    },
    async recover(
      action: AccountRecoveryAction,
      userId: string,
      body: unknown,
      proof: AdminReauthProofRef,
      key: string,
    ) {
      const headers = { "idempotency-key": key, "x-openmapx-reauth-challenge": proof.challengeId };
      const response =
        action === "verify"
          ? await accountSdk.verifyAdminAccount(
              userId,
              assistedAccountVerifySchema.parse(body),
              headers,
              { client },
            )
          : action === "password"
            ? await accountSdk.setAdminAccountPassword(
                userId,
                assistedAccountPasswordSchema.parse(body),
                headers,
                { client },
              )
            : action === "reset-password"
              ? await accountSdk.sendAdminAccountPasswordReset(
                  userId,
                  { confirmed: true },
                  headers,
                  { client },
                )
              : action === "verification-email"
                ? await accountSdk.sendAdminAccountVerificationEmail(
                    userId,
                    { confirmed: true },
                    headers,
                    { client },
                  )
                : await accountSdk.inviteAdminAccount(userId, { confirmed: true }, headers, {
                    client,
                  });
      return accountProvisioningResultSchema.parse(accountResponse(response));
    },
    async updateName(userId: string, name: string) {
      return unwrapAuthResult(
        await admin.updateUser({ userId, data: { name }, fetchOptions: writes() }),
      );
    },
    async changeRole(userId: string, role: string, expectedRole: string) {
      const body = accountRoleChangeSchema.parse({ role, expectedRole });
      return accountResponse(
        await accountSdk.changeAdminAccountRole(
          userId,
          body,
          { "idempotency-key": crypto.randomUUID() },
          { client },
        ),
      );
    },
    async ban(userId: string, banReason?: string) {
      return unwrapAuthResult(await admin.banUser({ userId, banReason, fetchOptions: writes() }));
    },
    async unban(userId: string) {
      return unwrapAuthResult(await admin.unbanUser({ userId, fetchOptions: writes() }));
    },
    async remove(userId: string) {
      return unwrapAuthResult(await admin.removeUser({ userId, fetchOptions: writes() }));
    },
    async impersonate(userId: string) {
      return unwrapAuthResult(await admin.impersonateUser({ userId, fetchOptions: writes() }));
    },
    async revoke(sessionToken: string) {
      return unwrapAuthResult(
        await admin.revokeUserSession({ sessionToken, fetchOptions: writes() }),
      );
    },
    async revokeAll(userId: string) {
      return unwrapAuthResult(await admin.revokeUserSessions({ userId, fetchOptions: writes() }));
    },
  };
}
export type AccountAdminClient = ReturnType<typeof createAccountAdminClient>;
export function useAccountAdmin() {
  const { apiUrl } = useEnv(),
    { data: session } = authClient.useSession(),
    actorId = session?.user?.id ?? "",
    { client } = useMemo(
      () => ({ actorId, client: createAccountAdminClient(apiUrl) }),
      [apiUrl, actorId],
    );
  const root = ["admin", "accounts", apiUrl, actorId] as const;
  return {
    client,
    apiUrl,
    actorId,
    root,
    keys: {
      list: (query?: unknown) => [...root, "list", query],
      count: [...root, "count"],
      detail: (id: string) => [...root, "detail", id],
      sessions: (id: string) => [...root, "sessions", id],
      delivery: (id: string) => [...root, "delivery", id],
      policy: [...root, "policy"],
    },
  };
}
/** Mutation variables retain a request closure, never a serialized password payload. */
export function useAccountAction<T = unknown>(
  targetId: string,
  options: {
    viewKey?: string;
    impersonation?: true;
    onSuccess?: (value: T) => void;
    onError?: (error: AccountAdminError) => void;
  } = {},
) {
  const scope = useAccountAdmin(),
    qc = useQueryClient(),
    viewKey = JSON.stringify([scope.apiUrl, targetId, options.viewKey]),
    view = useRef({ key: viewKey, token: {} });
  if (view.current.key !== viewKey) view.current = { key: viewKey, token: {} };
  const actor = useRef(scope.actorId);
  actor.current = scope.actorId;
  const key = JSON.stringify([scope.apiUrl, scope.actorId, targetId, options.viewKey]),
    owner = useRef({ key, token: {}, mounted: true });
  if (owner.current.key !== key) owner.current = { key, token: {}, mounted: true };
  useLayoutEffect(() => {
    owner.current.mounted = true;
    return () => {
      owner.current.mounted = false;
    };
  }, []);
  const owns = (token: object) => owner.current.mounted && owner.current.token === token;
  const mutation = useMutation({
    retry: false,
    networkMode: "always",
    mutationFn: async (request: {
      run: (client: AccountAdminClient) => Promise<T>;
      scope: typeof scope;
      token: object;
      viewToken: object;
      targetId: string;
    }) => {
      if (!request.scope.actorId) throw new AccountAdminError("UNAUTHORIZED");
      try {
        return await request.run(request.scope.client);
      } catch (error) {
        throw accountError(error);
      } finally {
        const root = request.scope.root;
        void qc.invalidateQueries({ queryKey: [...root, "list"] });
        void qc.invalidateQueries({ queryKey: [...root, "count"] });
        void qc.invalidateQueries({ queryKey: [...root, "detail", request.targetId] });
        void qc.invalidateQueries({ queryKey: [...root, "sessions", request.targetId] });
        void qc.invalidateQueries({ queryKey: [...root, "delivery", request.targetId] });
        void qc.invalidateQueries({ queryKey: [...root, "policy"] });
        if (owns(request.token)) {
          void qc.invalidateQueries({ queryKey: ["admin", "users"] });
          void qc.invalidateQueries({ queryKey: ["admin", "user", request.targetId] });
          void qc.invalidateQueries({ queryKey: ["admin", "user-sessions", request.targetId] });
        }
      }
    },
    onSuccess: (value, request) => {
      const expectedActor =
        options.impersonation &&
        owner.current.mounted &&
        view.current.token === request.viewToken &&
        actor.current === request.targetId &&
        (value as { user?: { id?: string } } | null)?.user?.id === request.targetId;
      if (owns(request.token) || expectedActor) options.onSuccess?.(value);
    },
    onError: (error, request) => {
      if (owns(request.token)) options.onError?.(accountError(error));
    },
  });
  return {
    mutate: (run: (client: AccountAdminClient) => Promise<T>) =>
      mutation.mutate({
        run,
        scope,
        token: owner.current.token,
        viewToken: view.current.token,
        targetId,
      }),
    isPending: !!mutation.variables && owns(mutation.variables.token) && mutation.isPending,
    error: mutation.variables && owns(mutation.variables.token) ? mutation.error : null,
    invalidateOwner: () => {
      owner.current.token = {};
      view.current.token = {};
    },
  };
}
