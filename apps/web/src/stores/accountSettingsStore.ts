import { create } from "zustand";

export type AccountSettingsSection = "timeline" | null;

interface AccountSettingsState {
  open: boolean;
  section: AccountSettingsSection;
  show: (section?: AccountSettingsSection) => void;
  close: () => void;
}

export const useAccountSettingsStore = create<AccountSettingsState>((set) => ({
  open: false,
  section: null,
  show: (section = null) => set({ open: true, section }),
  close: () => set({ open: false, section: null }),
}));
