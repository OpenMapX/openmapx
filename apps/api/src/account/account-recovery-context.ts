import { AsyncLocalStorage } from "node:async_hooks";
import { APIError } from "better-auth/api";
import { currentAccountMutation } from "./account-context";
import { AdminActionReauthentication } from "./admin-reauthentication";
import { type AuthDatabase, currentAuthDatabase } from "./auth-database";

type Purpose = "account.verify" | "account.password.set" | "account.reset.send" | "account.invite";
const admitted = new AsyncLocalStorage<{
  actorId: string;
  targetId: string;
  purpose: Purpose;
  database: AuthDatabase;
}>();
export function assertAccountRecoveryProof(
  actorId: string | null,
  targetId: string | null,
  purpose: Purpose,
) {
  const owner = admitted.getStore();
  if (
    !owner ||
    owner.actorId !== actorId ||
    owner.targetId !== targetId ||
    owner.purpose !== purpose ||
    owner.database !== currentAuthDatabase()
  )
    throw new APIError("FORBIDDEN", {
      code: "USE_ACCOUNT_ACTION",
      message: "Use the dedicated reauthenticated account action",
    });
}
export async function withAccountRecoveryProof<T>(
  input: {
    actorId: string;
    targetId: string;
    purpose: Purpose;
    challengeId: string;
    nonce: Buffer | string;
    sessionId: string;
  },
  tx: AuthDatabase,
  run: () => Promise<T>,
): Promise<T> {
  const owner = currentAccountMutation();
  if (
    !owner ||
    owner.actorId !== input.actorId ||
    owner.targetId !== input.targetId ||
    owner.database !== tx
  )
    throw Error("An owning account transaction is required");
  await new AdminActionReauthentication(tx).consume(
    {
      challengeId: input.challengeId,
      nonce: input.nonce,
      sessionId: input.sessionId,
      purpose: input.purpose,
      targetId: input.targetId,
    },
    tx,
  );
  return admitted.run({ ...input, database: tx }, run);
}
