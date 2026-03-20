"use client";

import { useSidebarStore } from "@openmapx/core";
import { DetailShell } from "./DetailShell";
import { DETAIL_PANELS, SIDEBAR_PANELS } from "./panel-map";
import { SidebarShell } from "./SidebarShell";

export function PanelHost() {
  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const activeDetailId = useSidebarStore((s) => s.activeDetailId);

  const sidebarEntry = activeSidebarId ? SIDEBAR_PANELS[activeSidebarId] : null;
  const DetailContent = activeDetailId ? DETAIL_PANELS[activeDetailId] : null;

  return (
    <>
      {sidebarEntry && (
        <SidebarShell contentSx={sidebarEntry.contentSx}>
          <sidebarEntry.component />
        </SidebarShell>
      )}
      {DetailContent && (
        <DetailShell>
          <DetailContent />
        </DetailShell>
      )}
    </>
  );
}
