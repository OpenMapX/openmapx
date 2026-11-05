"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import { AdminJobLink } from "../activity/AdminJobLink";
import { useActivityClient } from "../activity/activityQueries";
import { notablePlacesStatusQueryKey } from "../services/NotablePlacesMaintenance";
import { overtureStatusQueryKey } from "../services/OvertureMaintenance";
import { searchIndexStatusQueryKey } from "../services/SearchIndexMaintenance";
import { useAdminToast } from "../shared/AdminToast";
import { AdminOperationCard } from "./AdminOperationCard";

export function DataOperationLauncher({ operationIds }: { operationIds: readonly string[] }) {
  const { client, apiUrl } = useActivityClient();
  const toast = useAdminToast();
  const catalog = useQuery({
    ...serviceAdminQueries(client, apiUrl).operations(),
    staleTime: 300000,
  });
  const operations = catalog.data?.operations.filter((op) => operationIds.includes(op.id)) ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [lastJob, setLastJob] = useState<string | null>(null);
  useEffect(() => {
    const reveal = () => {
      const id = window.location.hash.slice("#operation-".length);
      if (window.location.hash.startsWith("#operation-") && operationIds.includes(id))
        setSelected(id);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [operationIds]);
  const operation = operations.find((op) => op.id === selected);
  return (
    <Stack sx={{ gap: 2 }}>
      {lastJob && (
        <Alert
          severity="info"
          action={
            <AdminJobLink id={lastJob} source="application">
              Inspect job
            </AdminJobLink>
          }
        >
          Operation accepted. Inspect its outcome in Activity.
        </Alert>
      )}
      {catalog.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void catalog.refetch()}>Retry</Button>}
        >
          Operations are unavailable.
        </Alert>
      )}
      {catalog.isLoading && <Typography>Loading operations…</Typography>}
      <Stack direction="row" useFlexGap sx={{ gap: 1, flexWrap: "wrap" }}>
        {operations.map((op) => (
          <Button
            id={`operation-${op.id}`}
            key={op.id}
            variant={selected === op.id ? "contained" : "outlined"}
            onClick={() => setSelected(selected === op.id ? null : op.id)}
            aria-expanded={selected === op.id}
          >
            {op.title}
          </Button>
        ))}
      </Stack>
      {operation && (
        <Box sx={{ maxWidth: 760, "& .MuiTextField-root": { maxWidth: 480 } }}>
          <AdminOperationCard
            key={`${apiUrl}:${operation.id}`}
            apiUrl={apiUrl}
            operation={operation}
            refreshKeys={[
              overtureStatusQueryKey(apiUrl),
              searchIndexStatusQueryKey(apiUrl),
              notablePlacesStatusQueryKey(apiUrl),
            ]}
            onQueued={(id) => {
              setLastJob(id);
              toast(`Queued ${operation.title} (${id})`);
            }}
            onError={(message) => toast(message, "error")}
          />
        </Box>
      )}
    </Stack>
  );
}
