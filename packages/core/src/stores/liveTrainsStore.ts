import { createOverlayStore } from "./createOverlayStore";

export const useLiveTrainsStore = createOverlayStore({
  extra: {
    selectedTrainId: null as string | null,
  },
  actions: (set) => ({
    selectTrain: (id: string | null) => set({ selectedTrainId: id }),
  }),
  onClose: () => ({ selectedTrainId: null }),
});
