"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
  ADVANCED_OPERATION_IDS,
  adminDataOperationHref,
  OSM_OPERATION_IDS,
} from "@/lib/admin/adminDataNavigation";
import { ADMIN_DESTINATIONS, adminDestinations } from "@/lib/admin/adminNavigation";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import { useAdminQueryState } from "@/lib/admin/useAdminQueryState";
import { useActivityClient } from "../activity/activityQueries";
import { DataOperationLauncher } from "../operations/DataOperationLauncher";
import { AmbientPlacesMaintenance } from "../services/AmbientPlacesMaintenance";
import { ArtifactTransfersSection } from "../services/ArtifactTransfersSection";
import { DataInventorySection } from "../services/DataInventorySection";
import { NotablePlacesMaintenance } from "../services/NotablePlacesMaintenance";
import { OsmExtractDetails } from "../services/OsmExtractDetails";
import { OvertureMaintenance } from "../services/OvertureMaintenance";
import { SearchIndexMaintenance } from "../services/SearchIndexMaintenance";
import { useAdminNavigationAccess } from "../shared/AdminNavigationContext";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { HostedDataTopics } from "../shared/HostedDataTopics";

export type DataTopic = "overview" | "osm" | "overture" | "search" | "transfers" | "operations";
export function DataWorkspace({ topic = "overview" }: { topic?: DataTopic }) {
  const { apiUrl } = useActivityClient();
  const t = useTranslations("adminNavigation");
  const router = useRouter();
  useEffect(() => {
    if (topic !== "overview") return;
    const hash = window.location.hash;
    if (hash === "#transit-sources") router.replace("/admin/data/transit?tab=sources");
    else if (hash.startsWith("#operation-")) {
      const id = hash.slice(11);
      if (/^[a-z0-9-]{1,128}$/.test(id)) router.replace(adminDataOperationHref(id));
    }
  }, [topic, router]);
  const destination = ADMIN_DESTINATIONS.find(
    (entry) => entry.href === `/admin/data${topic === "overview" ? "" : `/${topic}`}`,
  );
  return (
    <Stack key={`${apiUrl}:${topic}`} sx={{ gap: 2 }}>
      <AdminPageHeader
        title={t(`destinations.${destination?.id ?? "data"}.label`)}
        subtitle={t(`destinations.${destination?.id ?? "data"}.description`)}
      />
      {topic === "overview" && <DataDirectory />}
      {topic === "osm" && <OsmWorkspace />}
      {topic === "overture" && (
        <div id="operation-overture-sync">
          {["overture-pull", "overture-ingest", "overture-extract", "overture-conflate"].map(
            (id) => (
              <span id={`operation-${id}`} key={id} />
            ),
          )}
          <OvertureMaintenance apiUrl={apiUrl} />
        </div>
      )}
      {topic === "search" && (
        <>
          <div id="operation-search-index-build">
            <SearchIndexMaintenance apiUrl={apiUrl} />
          </div>
          <AmbientPlacesMaintenance apiUrl={apiUrl} />
          <div id="operation-notable-places-build">
            <NotablePlacesMaintenance apiUrl={apiUrl} />
          </div>
        </>
      )}
      {topic === "transfers" && <ArtifactTransfersSection apiUrl={apiUrl} />}
      {topic === "operations" && <DataOperationLauncher operationIds={ADVANCED_OPERATION_IDS} />}
    </Stack>
  );
}
function DataDirectory() {
  const { client, apiUrl } = useActivityClient();
  // No domain-specific status subscriptions or polling on the directory.
  const access = useAdminNavigationAccess();
  const t = useTranslations("adminNavigation");
  const query = useQuery({
    ...serviceAdminQueries(client, apiUrl).data(),
    enabled: access.role === "admin" && access.selfHosted !== false,
  });
  if (access.selfHosted === false) return <HostedDataTopics showHeader={false} />;
  return (
    <Stack sx={{ gap: 1 }}>
      {query.isError && (
        <Alert
          severity="warning"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        >
          Inventory summary is unavailable. Open a workspace to inspect its own status.
        </Alert>
      )}
      {adminDestinations(access)
        .filter((entry) => entry.workspace === "data" && entry.id !== "data")
        .map((entry) => (
          <Paper variant="outlined" key={entry.id} sx={{ p: 2 }}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              sx={{ gap: 1, alignItems: { sm: "center" } }}
            >
              <Stack sx={{ flex: 1 }}>
                <Typography component={Link} href={entry.href} sx={{ fontWeight: 650 }}>
                  {t(`destinations.${entry.id}.label`)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t(`destinations.${entry.id}.description`)}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {entry.id === "osm" && query.data
                  ? query.data.osm.unavailable
                    ? "Inventory unavailable"
                    : t("extractCount", { count: query.data.osm.total })
                  : t("openToInspect")}
              </Typography>
            </Stack>
          </Paper>
        ))}
    </Stack>
  );
}
function OsmWorkspace() {
  const { client, apiUrl } = useActivityClient();
  const { params, update } = useAdminQueryState();
  const raw = params.get("offset") ?? "0";
  const offset = /^\d{1,7}$/.test(raw) ? Math.min(Number(raw), 1000000) : 0;
  const query = useQuery({
    ...serviceAdminQueries(client, apiUrl).data({ osmLimit: 50, osmOffset: offset }),
    refetchInterval: 30000,
  });
  return (
    <Stack sx={{ gap: 2 }}>
      <DataOperationLauncher operationIds={OSM_OPERATION_IDS} />
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>Retry</Button>}
        >
          Failed to load data inventory.
        </Alert>
      )}
      {query.isLoading && <Typography>Loading inventory…</Typography>}
      {query.data && (
        <>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <OsmExtractDetails extract={query.data.osmExtract} />
          </Paper>
          <DataInventorySection
            osm={query.data.osm}
            builds={query.data.builds}
            onPageChange={(value) => update({ offset: value ? String(value) : null }, "replace")}
          />
        </>
      )}
    </Stack>
  );
}
