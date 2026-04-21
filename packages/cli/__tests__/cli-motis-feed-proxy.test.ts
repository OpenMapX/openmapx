import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFeedProxyVars, renderFeedProxyNginxConfig } from "../src/lib/motis-feed-proxy";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("motis-feed-proxy helpers", () => {
  it("returns an empty object when vars file is missing", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-feed-proxy-"));
    const vars = readFeedProxyVars(join(tmp, "missing.json"));
    expect(vars).toEqual({});
  });

  it("renders nginx config for /feed and gbfs host proxy entries", () => {
    const config = renderFeedProxyNginxConfig({
      "de-vbb-0": {
        url: "https://example.org/rt.pb",
        headers: {
          Authorization: "Bearer abc",
        },
      },
      "de-nextbike": {
        url: "https://gbfs.nextbike.net/gbfs.json",
        gbfs: true,
      },
    });

    expect(config).toContain('location "/feed/de-vbb-0"');
    expect(config).toContain('proxy_set_header "Authorization" "Bearer abc";');
    expect(config).toContain('server_name "gbfs.nextbike.net";');
    expect(config).toContain("location = /healthz");
  });

  it("rejects invalid source URLs", () => {
    expect(() =>
      renderFeedProxyNginxConfig({
        bad: {
          url: "not-a-url",
        },
      }),
    ).toThrow(/Invalid feed-proxy source URL/);
  });

  it("loads and normalizes feed-proxy vars from JSON", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-feed-proxy-vars-"));
    const varsPath = join(tmp, "feed-proxy-vars.json");
    writeFileSync(
      varsPath,
      JSON.stringify(
        {
          "de-vbb-0": {
            url: " https://example.org/rt.pb ",
            headers: {
              Authorization: "Bearer abc",
              Empty: "",
            },
          },
          invalid: {
            headers: {
              Foo: "bar",
            },
          },
        },
        null,
        2,
      ),
    );

    const vars = readFeedProxyVars(varsPath);
    expect(vars).toEqual({});
  });
});
