"use client";

import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useAdminTab } from "@/lib/admin/useAdminQueryState";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AppLogViewer } from "./AppLogViewer";
import { AuditLog } from "./AuditLog";
import { JobList } from "./JobList";

export function ActivityTabs() {
  const [tab, setTab] = useAdminTab(["jobs", "audit", "logs"]);

  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader title="Activity" subtitle="Jobs, audit events, and application logs" />
      <Tabs value={tab} onChange={(_, v) => setTab(v as number)} aria-label="Activity views">
        <Tab id="activity-tab-0" aria-controls="activity-panel-0" label="Jobs" />
        <Tab id="activity-tab-1" aria-controls="activity-panel-1" label="Audit Log" />
        <Tab id="activity-tab-2" aria-controls="activity-panel-2" label="Application Logs" />
      </Tabs>
      <div role="tabpanel" id={`activity-panel-${tab}`} aria-labelledby={`activity-tab-${tab}`}>
        {tab === 0 && <JobList />}
        {tab === 1 && <AuditLog />}
        {tab === 2 && <AppLogViewer />}
      </div>
    </Stack>
  );
}
