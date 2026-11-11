"use client";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { serviceAdminQueries } from "@/lib/admin/serviceAdmin";
import { useAdminQueryState } from "@/lib/admin/useAdminQueryState";
import { useActivityClient } from "../activity/activityQueries";
import {
  readTransitCredentialContinuation,
  TransitCredentialsSection,
} from "../services/TransitCredentialsSection";
import { TransitSourcesSection } from "../services/TransitSourcesSection";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { LockfileCard } from "./LockfileCard";
import { MotisTransitousSection, SharedMobilitySourcesSection } from "./TransitMobilitySections";
import { TransitPipelinePage } from "./TransitPipelinePage";

const TABS = ["sources", "catalog", "credentials", "pipeline", "mobility"] as const;
export function TransitWorkspace() {
  const { apiUrl, actorId } = useAccountAdmin();
  return <TransitView key={`${apiUrl}:${actorId}`} apiUrl={apiUrl} actorId={actorId} />;
}
function TransitView({ apiUrl, actorId }: { apiUrl: string; actorId: string }) {
  const { params, update } = useAdminQueryState();
  const raw = params.get("tab");
  const tab = TABS.find((value) => value === raw) ?? "sources";
  const restored = useRef(false);
  const [proposalId, setProposalId] = useState<string>();
  const [proposalFinished, setProposalFinished] = useState(false);
  useEffect(() => {
    if (!actorId || restored.current) return;
    restored.current = true;
    const pending = readTransitCredentialContinuation(apiUrl, actorId);
    if (pending) {
      setProposalId(pending.proposalId);
      update({ tab: "credentials" }, "replace");
    }
  }, [apiUrl, actorId, update]);
  useEffect(() => {
    if (tab !== "credentials" && proposalFinished) {
      setProposalId(undefined);
      setProposalFinished(false);
    }
  }, [tab, proposalFinished]);
  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader
        title="Transit"
        subtitle="Sources, reviewed catalog pins, credentials and pipeline health"
      />
      <Tabs
        value={tab}
        onChange={(_, value: string) => update({ tab: value })}
        variant="scrollable"
        scrollButtons="auto"
        aria-label="Transit sections"
      >
        {TABS.map((value) => (
          <Tab
            key={value}
            value={value}
            id={`transit-tab-${value}`}
            aria-controls={`transit-panel-${value}`}
            label={value[0].toUpperCase() + value.slice(1)}
          />
        ))}
      </Tabs>
      <div role="tabpanel" id={`transit-panel-${tab}`} aria-labelledby={`transit-tab-${tab}`}>
        {tab === "sources" && (
          <div id="transit-sources">
            <TransitSourcesSection apiUrl={apiUrl} />
          </div>
        )}
        {tab === "catalog" && <LockfileCard />}
        {tab === "credentials" && (
          <TransitCredentialsSection
            proposalId={proposalId}
            onReviewFinished={() => setProposalFinished(true)}
          />
        )}
        {tab === "pipeline" && <TransitPipelinePage showHeader={false} />}
        {tab === "mobility" && <MobilityView />}
      </div>
    </Stack>
  );
}
export function TransitMobilityView() {
  return <MobilityView />;
}
function MobilityView() {
  const { client, apiUrl } = useActivityClient();
  const query = useQuery({ ...serviceAdminQueries(client, apiUrl).data(), refetchInterval: 30000 });
  return (
    <Stack sx={{ gap: 2 }}>
      {query.isError && <Alert severity="error">MOTIS evidence is unavailable.</Alert>}
      {query.data && <MotisTransitousSection status={query.data.motisTransitous} />}
      <SharedMobilitySourcesSection apiUrl={apiUrl} />
    </Stack>
  );
}
