import { authClient } from "./client";

export function useSession() {
  return authClient.useSession();
}

/**
 * Fetches the session again, for example after the API refused a request
 * because the session has ended, so the UI stops presenting the user as
 * signed in.
 */
export function refreshSession(): void {
  authClient.$store.notify("$sessionSignal");
}
