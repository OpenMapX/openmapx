import { useSidebarStore } from "../stores/sidebarStore";

export function useActiveSidePanel() {
  const isOpen = useSidebarStore((s) => s.activeSidebarId !== null);
  const close = useSidebarStore((s) => s.closeAll);
  return { isOpen, close };
}
