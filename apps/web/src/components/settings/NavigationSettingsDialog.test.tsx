import { useSettingsStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileRuntimeProvider } from "@/lib/mobile/MobileRuntimeProvider";
import { NavigationSettingsDialog } from "./NavigationSettingsDialog";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
afterEach(cleanup);

it("hides unavailable junction controls even with saved opt-in, retaining other navigation controls", () => {
  useSettingsStore.setState({ junctionView: true, junctionPhotos: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MobileRuntimeProvider webBuildId="test" scope={{}}>
        <NavigationSettingsDialog open onClose={() => {}} />
      </MobileRuntimeProvider>
    </QueryClientProvider>,
  );
  expect(view.queryByText("settings.junctionView")).toBeNull();
  expect(view.queryByText("settings.junctionPhotos")).toBeNull();
  expect(view.getByText("navigationSettings.voiceGuidance")).toBeTruthy();
  expect(view.getByText("settings.speedCameraAlerts")).toBeTruthy();
});
