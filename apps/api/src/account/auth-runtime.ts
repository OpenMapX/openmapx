import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthPolicySnapshot } from "@openmapx/core/api-contracts";
import { isAPIError } from "better-auth/api";
import { accountAuthEntry } from "./auth-account-entry";
import {
  type AuthDatabase,
  currentAuthDatabase,
  isTransactionalAuthDatabase,
  withAuthDatabase,
} from "./auth-database";
import { AuthPolicyError, loadAuthPolicy, unactivatedAuthPolicy } from "./auth-policy";
import { withFactorEntrySession } from "./factor-entry-context";
/** The facade never returns a raw mutable runtime. Nested calls keep their original snapshot/transaction. */
export function createAuthRuntime<
  T extends {
    api: object;
    handler: (request: Request) => Promise<Response>;
    $context: Promise<unknown>;
  },
>(create: (policy: AuthPolicySnapshot, database: AuthDatabase) => T) {
  const local = new AsyncLocalStorage<{
    instance: T;
    policy: AuthPolicySnapshot;
    database: AuthDatabase;
  }>();
  let cached: { revision: string; instance: T } | undefined;
  const template = create(unactivatedAuthPolicy, currentAuthDatabase());
  async function withAuthOperation<R>(run: (instance: T) => Promise<R>): Promise<R> {
    const pinned = local.getStore();
    const database = currentAuthDatabase();
    if (pinned?.database === database) return run(pinned.instance);
    const policy = pinned?.policy ?? (await loadAuthPolicy(database)),
      transactional = isTransactionalAuthDatabase();
    let instance: T;
    if (!transactional && cached?.revision === policy.revision) instance = cached.instance;
    else {
      instance = create(policy, database);
      if (!transactional) cached = { revision: policy.revision, instance };
    }
    return local.run({ instance, policy, database }, () => run(instance));
  }
  const rawSession = (headers: HeadersInit | undefined) =>
    withAuthOperation(async (instance) =>
      Reflect.apply(Reflect.get(instance.api, "getSession"), instance.api, [
        {
          headers: headers ?? new Headers(),
          query: { disableCookieCache: true, disableRefresh: true },
        },
      ]),
    );
  class ResetResponseRollback extends Error {
    constructor(readonly response: Response) {
      super("Password reset did not commit");
    }
  }
  // In installed Better Auth 1.7.7 these exact errors are emitted only by
  // atomicVerifyOTP, before hashing/writing the password. Commit their attempt
  // accounting; roll back every later/unrecognized failure with OTP consumption.
  const otpRefusal = (body: unknown, status: number) => {
    const code = (body as { code?: unknown } | null)?.code;
    return (
      (status === 400 && (code === "INVALID_OTP" || code === "OTP_EXPIRED")) ||
      (status === 403 && code === "TOO_MANY_ATTEMPTS")
    );
  };
  async function entry<R>(reset: boolean, run: () => Promise<R>): Promise<R> {
    if (!reset || isTransactionalAuthDatabase()) return run();
    try {
      const outcome = await currentAuthDatabase().transaction((tx) =>
        withAuthDatabase(tx, async () => {
          try {
            const value = await run();
            if (value instanceof Response && value.status >= 400) {
              const body: unknown = await value
                .clone()
                .json()
                .catch(() => null);
              if (!otpRefusal(body, value.status)) throw new ResetResponseRollback(value);
            }
            return { kind: "value" as const, value };
          } catch (error) {
            if (isAPIError(error) && otpRefusal(error.body, error.statusCode))
              return { kind: "error" as const, error };
            throw error;
          }
        }),
      );
      if (outcome.kind === "error") throw outcome.error;
      return outcome.value;
    } catch (error) {
      if (error instanceof ResetResponseRollback) return error.response as R;
      throw error;
    }
  }
  const api = new Proxy(template.api, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return Object.assign(
        (...args: unknown[]) =>
          (async () => {
            const input = (args[0] ?? {}) as {
              body?: unknown;
              headers?: HeadersInit;
              request?: Request;
              asResponse?: boolean;
            };
            try {
              return await withAuthOperation(() =>
                withFactorEntrySession(
                  String(key),
                  () => rawSession(input.headers),
                  () =>
                    accountAuthEntry(
                      {
                        entry: String(key),
                        body: input.body,
                        headers: input.headers,
                        internal: !input.headers && !input.request,
                      },
                      () =>
                        withAuthOperation(async (instance) =>
                          Reflect.apply(Reflect.get(instance.api, "getSession"), instance.api, [
                            {
                              headers: input.headers ?? new Headers(),
                              query: { disableCookieCache: true, disableRefresh: true },
                            },
                          ]),
                        ),
                      () =>
                        entry(key === "resetPasswordEmailOTP", () =>
                          withAuthOperation(async (instance) =>
                            Reflect.apply(Reflect.get(instance.api, key), instance.api, args),
                          ),
                        ),
                    ),
                ),
              );
            } catch (error) {
              if (input.asResponse && isAPIError(error))
                return Response.json(error.body, { status: error.statusCode });
              throw error;
            }
          })(),
        value,
      );
    },
  });
  const auth = new Proxy(template, {
    get(target, key) {
      if (key === "api") return api;
      if (key === "handler")
        return async (request: Request) => {
          try {
            const path = new URL(request.url).pathname;
            const body =
              request.method === "POST"
                ? await request
                    .clone()
                    .json()
                    .catch(() => null)
                : null;
            return await withAuthOperation(() =>
              withFactorEntrySession(
                path,
                () => rawSession(request.headers),
                () =>
                  accountAuthEntry(
                    { entry: path, body, headers: request.headers, internal: false },
                    () =>
                      withAuthOperation(async (instance) =>
                        Reflect.apply(Reflect.get(instance.api, "getSession"), instance.api, [
                          {
                            headers: request.headers,
                            query: { disableCookieCache: true, disableRefresh: true },
                          },
                        ]),
                      ),
                    () =>
                      entry(path === "/api/auth/email-otp/reset-password", () =>
                        withAuthOperation((instance) => instance.handler(request)),
                      ),
                  ),
              ),
            );
          } catch (error) {
            if (isAPIError(error)) return Response.json(error.body, { status: error.statusCode });
            if (error instanceof AuthPolicyError)
              return Response.json(
                { code: error.code, message: "Authentication policy is unavailable" },
                { status: 503 },
              );
            throw error;
          }
        };
      if (key === "$context") return withAuthOperation((instance) => instance.$context);
      return Reflect.get(target, key);
    },
  });
  return { auth, withAuthOperation };
}
