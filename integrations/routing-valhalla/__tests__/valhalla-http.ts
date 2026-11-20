import { fakeHttpClient } from "@openmapx/integration-framework/testing";
import { createValhallaService, type ValhallaSettings } from "../provider.js";

export type ValhallaFetch = (
  url: string,
  init: { method: "POST"; body: string },
) => Response | Promise<Response>;

/**
 * A Valhalla provider whose requests a test answers like fetch: `answer` gets
 * the URL with its query and the JSON body. Replace `answer` and `settings`
 * per test.
 */
export function valhallaHarness() {
  const harness = {
    answer: (async () => Response.json({})) as ValhallaFetch,
    settings: { bidirectionalAlternates: true } as ValhallaSettings,
    service: undefined as unknown as ReturnType<typeof createValhallaService>,
  };
  const http = fakeHttpClient(async ({ url, body, options }) => {
    const requestUrl = new URL(url);
    for (const [name, value] of Object.entries(options?.params ?? {})) {
      if (value !== undefined) requestUrl.searchParams.set(name, String(value));
    }
    const response = await harness.answer(requestUrl.toString(), {
      method: "POST",
      body: body as string,
    });
    return { status: response.status, headers: {}, body: await response.text() };
  });
  harness.service = createValhallaService(http, () => harness.settings);
  return harness;
}
