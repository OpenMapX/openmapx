"use client";

import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useSavedPlacesStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { TEAL } from "@/lib/theme";
import { SavedLabeledTab } from "./SavedLabeledTab";
import { SavedListDetail } from "./SavedListDetail";
import { SavedListsTab } from "./SavedListsTab";

export function SavedPlacesContent() {
  const t = useTranslations("saved");
  const activeTab = useSavedPlacesStore((s) => s.activeTab);
  const setActiveTab = useSavedPlacesStore((s) => s.setActiveTab);
  const selectedListId = useSavedPlacesStore((s) => s.selectedListId);

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
          "& .MuiTabs-flexContainer": { justifyContent: "space-evenly" },
          "& .MuiTab-root": {
            textTransform: "none",
            fontSize: 14,
            fontWeight: 500,
            minHeight: 48,
            minWidth: "auto",
            color: "#5f6368",
          },
          "& .Mui-selected": { color: `${TEAL} !important` },
          "& .MuiTabs-indicator": {
            height: 3,
            display: "flex",
            justifyContent: "center",
            backgroundColor: "transparent",
            "&::after": {
              content: '""',
              display: "block",
              width: "calc(100% - 32px)",
              backgroundColor: TEAL,
              borderRadius: "2px 2px 0 0",
            },
          },
          borderBottom: "1px solid rgba(0,0,0,0.1)",
        }}
      >
        <Tab label={t("lists")} />
        <Tab label={t("labeled")} />
      </Tabs>

      {activeTab === "lists" ? <SavedListsTab /> : <SavedLabeledTab />}
    </>
  );
}
