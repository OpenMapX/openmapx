"use client";

import Box from "@mui/material/Box";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useState } from "react";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AppLogViewer } from "./AppLogViewer";
import { AuditLog } from "./AuditLog";
import { JobList } from "./JobList";

export function ActivityTabs() {
  const [tab, setTab] = useState(0);

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <AdminPageHeader title="Activity" />
      </Box>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as number)}
        sx={{ mb: 3, borderBottom: 1, borderColor: "divider" }}
      >
        <Tab label="Jobs" />
        <Tab label="Audit Log" />
        <Tab label="Application Logs" />
      </Tabs>
      {tab === 0 && <JobList />}
      {tab === 1 && <AuditLog />}
      {tab === 2 && <AppLogViewer />}
    </Box>
  );
}
