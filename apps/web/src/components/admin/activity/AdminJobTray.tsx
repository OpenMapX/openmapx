"use client";
import WorkIcon from "@mui/icons-material/WorkHistory";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Link from "next/link";
import { useState } from "react";
import Popover from "@/components/ui/Popover";
import { useAdminObservedJobs } from "@/lib/admin/adminJobEffects";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import { JobStatusChip } from "../shared/JobStatusChip";
export function AdminJobTray() {
  const jobs = useAdminObservedJobs();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const active = jobs.filter((job) => !job.settled).length;
  const recent = [...jobs]
    .reverse()
    .sort((a, b) => Number(a.settled) - Number(b.settled))
    .slice(0, 8);
  return (
    <>
      <IconButton
        size="small"
        aria-label={`Administration jobs${active ? `, ${active} active` : ""}`}
        aria-expanded={!!anchor}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <Badge color="primary" badgeContent={active}>
          <WorkIcon fontSize="small" />
        </Badge>
      </IconButton>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Stack sx={{ p: 2, gap: 1, width: 360, maxWidth: "calc(100vw - 24px)" }}>
          <Typography variant="subtitle2">Administration jobs · {active} active</Typography>
          {recent.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              Accepted jobs appear here during this administration session.
            </Typography>
          )}
          {recent.map((job) => (
            <Box key={job.jobId} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Button
                component={Link}
                href={adminJobHref({ id: job.jobId, source: job.source, returnTo: job.returnTo })}
                onClick={() => setAnchor(null)}
                size="small"
                sx={{
                  minWidth: 0,
                  flex: 1,
                  justifyContent: "flex-start",
                  overflowWrap: "anywhere",
                }}
              >
                {job.label}
              </Button>
              {job.unresolved ? (
                <Typography variant="caption" color="warning.main">
                  Outcome unknown
                </Typography>
              ) : (
                <JobStatusChip status={job.status} />
              )}
            </Box>
          ))}
          <Button
            component={Link}
            href="/admin/activity?tab=jobs"
            onClick={() => setAnchor(null)}
            size="small"
          >
            All jobs
          </Button>
          <Typography variant="caption" color="text.secondary">
            Refresh clears this session tray. Activity retains server history.
          </Typography>
        </Stack>
      </Popover>
    </>
  );
}
