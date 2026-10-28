import { AsyncLocalStorage } from "node:async_hooks";

const factorEntry = new AsyncLocalStorage<{ hadSession: boolean }>();
export const currentFactorEntryHadSession = () => factorEntry.getStore()?.hadSession;
export async function withFactorEntrySession<T>(
  entry: string,
  readSession: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  if (
    ![
      "verifyTOTP",
      "verifyBackupCode",
      "/api/auth/two-factor/verify-totp",
      "/api/auth/two-factor/verify-backup-code",
    ].includes(entry)
  )
    return run();
  const session = await readSession();
  if (session !== null && (typeof session !== "object" || !session || !("session" in session)))
    throw Error("Factor-entry session verification failed");
  return factorEntry.run({ hadSession: session !== null }, run);
}
