import { authClient } from "./client";

export function useSession() {
  return authClient.useSession();
}
