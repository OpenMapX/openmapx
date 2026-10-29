"use client";

import { authClient } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useState } from "react";

export interface CredentialMessage {
  type: "success" | "error";
  text: string;
}

interface Passkey {
  id: string;
  name?: string | null;
  createdAt?: Date | null;
}

function initialState(ownerId: string | null) {
  return {
    ownerId,
    lifetime: { active: false, busy: false, passkeysRevision: 0, accountsRevision: 0 },
    passkeys: [] as Passkey[],
    linkedAccounts: [] as { id: string; providerId: string }[],
    confirmUnlinkProvider: null as string | null,
    loadingPasskeys: ownerId !== null,
    loadingAccounts: ownerId !== null,
    pending: false,
  };
}

type CredentialState = ReturnType<typeof initialState>;

/** Credential inventory and actions belong to one open-account lifetime, including A→B→A. */
export function useAccountCredentials(
  ownerId: string | null,
  onMessage: (message: CredentialMessage | null) => void,
) {
  const t = useTranslations("account");
  const loadFailureText = t("unexpectedError");
  const [state, setState] = useState(() => initialState(ownerId));
  if (state.ownerId !== ownerId) setState(initialState(ownerId));
  const { lifetime } = state;

  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);

  useEffect(() => {
    if (ownerId === null) return;
    let cancelled = false;
    const passkeysRevision = lifetime.passkeysRevision;
    const accountsRevision = lifetime.accountsRevision;
    const current = () => !cancelled && lifetime.active;
    const loadPasskeys = async () => {
      try {
        const { data, error } = await authClient.passkey.listUserPasskeys();
        if (!current()) return;
        if (error) onMessage({ type: "error", text: loadFailureText });
        else if (data && passkeysRevision === lifetime.passkeysRevision) {
          setState((prev) => (prev.lifetime === lifetime ? { ...prev, passkeys: data } : prev));
        }
      } catch {
        if (current()) onMessage({ type: "error", text: loadFailureText });
      } finally {
        if (current())
          setState((prev) =>
            prev.lifetime === lifetime ? { ...prev, loadingPasskeys: false } : prev,
          );
      }
    };
    const loadAccounts = async () => {
      try {
        const { data, error } = await authClient.listAccounts();
        if (!current()) return;
        if (error) onMessage({ type: "error", text: loadFailureText });
        else if (data && accountsRevision === lifetime.accountsRevision) {
          const linkedAccounts = data.map(({ id, providerId }) => ({ id, providerId }));
          setState((prev) => (prev.lifetime === lifetime ? { ...prev, linkedAccounts } : prev));
        }
      } catch {
        if (current()) onMessage({ type: "error", text: loadFailureText });
      } finally {
        if (current())
          setState((prev) =>
            prev.lifetime === lifetime ? { ...prev, loadingAccounts: false } : prev,
          );
      }
    };
    void loadPasskeys();
    void loadAccounts();
    return () => {
      cancelled = true;
    };
  }, [ownerId, lifetime, loadFailureText, onMessage]);

  const current = () => ownerId !== null && lifetime.active;
  const update = (apply: (prev: CredentialState) => CredentialState) => {
    if (current()) setState((prev) => (prev.lifetime === lifetime ? apply(prev) : prev));
  };
  const notify = (message: CredentialMessage | null) => {
    if (current()) onMessage(message);
  };
  // The synchronous guard covers repeated clicks before React renders disabled controls.
  const begin = (family: "passkeysRevision" | "accountsRevision") => {
    if (!current() || lifetime.busy) return false;
    lifetime.busy = true;
    lifetime[family]++;
    update((prev) => ({ ...prev, pending: true }));
    notify(null);
    return true;
  };
  const finish = (family: "passkeysRevision" | "accountsRevision") => {
    lifetime.busy = false;
    lifetime[family]++;
    update((prev) => ({ ...prev, pending: false }));
  };

  const addPasskey = async () => {
    if (state.loadingPasskeys || !begin("passkeysRevision")) return;
    try {
      const { data, error } = await authClient.passkey.addPasskey();
      if (!current()) return;
      if (error || !data) {
        notify({ type: "error", text: t("failedAddPasskey") });
        return;
      }
      // The successful plugin response is the new passkey; a failed refetch cannot undo it.
      const passkey = { id: data.id, name: data.name, createdAt: data.createdAt };
      update((prev) => ({
        ...prev,
        passkeys: [...prev.passkeys.filter((key) => key.id !== passkey.id), passkey],
      }));
      notify({ type: "success", text: t("passkeyAdded") });
    } catch {
      notify({ type: "error", text: t("failedAddPasskey") });
    } finally {
      finish("passkeysRevision");
    }
  };

  const deletePasskey = async (id: string) => {
    if (!state.passkeys.some((key) => key.id === id) || !begin("passkeysRevision")) return;
    try {
      const { error } = await authClient.passkey.deletePasskey({ id });
      if (error) {
        notify({ type: "error", text: t("failedRemovePasskey") });
        return;
      }
      update((prev) => ({ ...prev, passkeys: prev.passkeys.filter((key) => key.id !== id) }));
      notify({ type: "success", text: t("passkeyRemoved") });
    } catch {
      notify({ type: "error", text: t("failedRemovePasskey") });
    } finally {
      finish("passkeysRevision");
    }
  };

  const linkProvider = async (providerId: string, providerName: string) => {
    if (state.loadingAccounts || !begin("accountsRevision")) return;
    try {
      const { data, error } = await authClient.linkSocial({
        provider: providerId,
        callbackURL: window.location.origin,
        disableRedirect: true,
      });
      if (!current()) return;
      if (error) {
        notify({ type: "error", text: t("failedLink", { provider: providerName }) });
        return;
      }
      // Keep the server-generated OAuth URL/callback; retire stale responses before navigation.
      if (data?.url) window.location.assign(data.url);
    } catch {
      notify({ type: "error", text: t("failedLink", { provider: providerName }) });
    } finally {
      finish("accountsRevision");
    }
  };

  const unlinkProvider = async (providerId: string, providerName: string) => {
    const account = state.linkedAccounts.find((entry) => entry.providerId === providerId);
    if (!account || !begin("accountsRevision")) return;
    try {
      const { error } = await authClient.unlinkAccount({ accountId: account.id });
      if (error) {
        notify({ type: "error", text: t("failedUnlink", { provider: providerName }) });
        return;
      }
      update((prev) => ({
        ...prev,
        linkedAccounts: prev.linkedAccounts.filter((entry) => entry.id !== account.id),
        confirmUnlinkProvider: null,
      }));
      notify({ type: "success", text: t("accountUnlinked", { provider: providerName }) });
    } catch {
      notify({ type: "error", text: t("failedUnlink", { provider: providerName }) });
    } finally {
      finish("accountsRevision");
    }
  };

  return {
    passkeys: state.passkeys,
    linkedAccounts: state.linkedAccounts,
    confirmUnlinkProvider: state.confirmUnlinkProvider,
    setConfirmUnlinkProvider: (providerId: string | null) => {
      if (!lifetime.busy) update((prev) => ({ ...prev, confirmUnlinkProvider: providerId }));
    },
    passkeysBusy: state.pending || state.loadingPasskeys,
    providersBusy: state.pending || state.loadingAccounts,
    addPasskey,
    deletePasskey,
    linkProvider,
    unlinkProvider,
  };
}
