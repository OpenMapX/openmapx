import { createApiClient } from "@openmapx/core";
import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  type PrivacyCaseClient,
  privacyAdminQueries,
  usePrivacyCaseClient,
} from "@/lib/admin/privacyAdmin";
import { createTestQueryClient } from "@/test/query";

function PrivacyTestHost({
  value,
  binding,
  children,
}: {
  value: PrivacyAdminDetail;
  binding: Parameters<typeof usePrivacyCaseClient>[1];
  children: (client: PrivacyCaseClient) => ReactNode;
}) {
  const client = usePrivacyCaseClient(value, binding);
  return (
    <>
      {client.errorCode && <output>{client.errorCode}</output>}
      {children(client)}
    </>
  );
}
export function renderPrivacyComponent(
  detail: PrivacyAdminDetail,
  children: (client: PrivacyCaseClient) => ReactNode,
) {
  const qc = createTestQueryClient(),
    api = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
  const binding = {
    client: api,
    apiOrigin: "http://privacy.test",
    actorId: "synthetic-worker",
    queries: privacyAdminQueries(api, "http://privacy.test", "synthetic-worker"),
  };
  const result = render(
    <QueryClientProvider client={qc}>
      <PrivacyTestHost value={detail} binding={binding}>
        {children}
      </PrivacyTestHost>
    </QueryClientProvider>,
  );
  return { ...result, qc, api };
}
export const privacyJson = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
