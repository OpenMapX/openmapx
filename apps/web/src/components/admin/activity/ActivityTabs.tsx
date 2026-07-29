"use client";

import Stack from "@mui/material/Stack";
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
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title="Activity" subtitle="Jobs, audit events, and application logs" />
      <Tabs value={tab} onChange={(_, v) => setTab(v as number)} aria-label="Activity views">
        <Tab label="Jobs" />
        <Tab label="Audit Log" />
        <Tab label="Application Logs" />
      </Tabs>
      {tab === 0 && <JobList />}
      {tab === 1 && <AuditLog />}
      {tab === 2 && <AppLogViewer />}
    </Stack>
  );
}
