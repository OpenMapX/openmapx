"use client";

import { createContext, type ReactNode, useContext } from "react";
import { MangroveSignerProvider } from "./signerProvider";
import type { MangroveCurrentUser, MangroveTransport } from "./transport";

interface MangroveContextValue {
  transport: MangroveTransport;
  currentUser: MangroveCurrentUser | null;
  webauthnKeyName: string | undefined;
}

const MangroveContext = createContext<MangroveContextValue | null>(null);

export interface MangroveProviderProps {
  transport: MangroveTransport;
  /** The signed-in user, or `null` when signed out. */
  currentUser: MangroveCurrentUser | null;
  /**
   * Browser-visible name attached to passkeys this app registers (shown in
   * the OS / password-manager picker). When omitted, the package falls back
   * to {@link WEBAUTHN_CREDENTIAL_KEY_NAME} from `@openmapx/mangrove-client`
   * (currently `"Mangrove Reviews"`). Set this per-deployment so users can
   * tell which app a credential belongs to.
   */
  webauthnKeyName?: string;
  children: ReactNode;
}

/**
 * Wraps the React tree with the host's Mangrove transport + current user.
 * All hooks in this package read these from context — they have no
 * dependency on any specific HTTP client, route table, or session library.
 */
export function MangroveProvider({
  transport,
  currentUser,
  webauthnKeyName,
  children,
}: MangroveProviderProps) {
  return (
    <MangroveContext.Provider value={{ transport, currentUser, webauthnKeyName }}>
      <MangroveSignerProvider
        owner={
          currentUser
            ? JSON.stringify([currentUser.id, currentUser.authorityId ?? currentUser.id])
            : null
        }
        transport={transport.signer}
      >
        {children}
      </MangroveSignerProvider>
    </MangroveContext.Provider>
  );
}

function useMangroveContext(): MangroveContextValue {
  const ctx = useContext(MangroveContext);
  if (!ctx) {
    throw new Error("@openmapx/mangrove-react hooks must be used inside <MangroveProvider>");
  }
  return ctx;
}

export function useMangroveTransport<TReview = unknown, TAggregate = unknown>(): MangroveTransport<
  TReview,
  TAggregate
> {
  return useMangroveContext().transport as MangroveTransport<TReview, TAggregate>;
}

export function useMangroveCurrentUser(): MangroveCurrentUser | null {
  return useMangroveContext().currentUser;
}

export function useMangroveWebauthnKeyName(): string | undefined {
  return useMangroveContext().webauthnKeyName;
}
