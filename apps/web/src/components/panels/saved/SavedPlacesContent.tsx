"use client";

import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useSavedPlacesStore, useSession, useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { SavedLabeledTab } from "./SavedLabeledTab";
import { SavedListDetail } from "./SavedListDetail";
import { SavedListsTab } from "./SavedListsTab";

export function SavedPlacesContent() {
  const t = useTranslations("saved");
  const activeTab = useSavedPlacesStore((s) => s.activeTab);
  const setActiveTab = useSavedPlacesStore((s) => s.setActiveTab);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);
  const { data: session, isPending } = useSession();

  // Defense-in-depth: refuse to mount when the user is not signed in.
  // The HamburgerMenu and command palette already gate Saved on auth, but
  // a deep link (e.g. ?panel=saved) would otherwise mount an empty panel
  // backed by 401s. Once the session resolves, close the sidebar so the
  // user lands back on the map. Do not auto-open AuthDialog here — that's
  // the caller's responsibility (HamburgerMenu does this).
  useEffect(() => {
    if (isPending) return;
    if (!session?.user?.id) {
      useSidebarStore.getState().closeAll();
    }
  }, [isPending, session?.user?.id]);
  if (!isPending && !session?.user?.id) return null;

  if (selectedListId !== null) {
    return <SavedListDetail />;
  }

  return (
    <>
      <Tabs
        value={activeTab === "lists" ? 0 : 1}
        onChange={(_, v: number) => setActiveTab(v === 0 ? "lists" : "labeled")}
        sx={{
          minHeight: 48,
          "& .MuiTabs-list": { justifyContent: "space-evenly" },
          "& .MuiTab-root": {
            textTransform: "none",
            fontSize: 14,
            fontWeight: 500,
            minHeight: 48,
            minWidth: "auto",
            color: "text.secondary",
          },
          "& .Mui-selected": { color: `${BRAND} !important` },
          "& .MuiTabs-indicator": {
            height: 3,
            display: "flex",
            justifyContent: "center",
            backgroundColor: "transparent",
            "&::after": {
              content: '""',
              display: "block",
              width: "calc(100% - 32px)",
              backgroundColor: BRAND,
              borderRadius: "2px 2px 0 0",
            },
          },
          borderBottom: "1px solid var(--omx-border-light)",
        }}
      >
        <Tab label={t("lists")} />
        <Tab label={t("labeled")} />
      </Tabs>

      {activeTab === "lists" ? <SavedListsTab /> : <SavedLabeledTab />}
    </>
  );
}
