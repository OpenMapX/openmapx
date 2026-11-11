import { create } from "zustand";

interface AuthPromptState {
  open: boolean;
  show: () => void;
  close: () => void;
}

/**
 * Opens the sign-in dialog from outside the signed-in tree. The state lives in
 * a store because that tree remounts when the session changes, which would
 * otherwise close a dialog opened just before the session refresh lands.
 */
export const useAuthPromptStore = create<AuthPromptState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
