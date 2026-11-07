import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFeedProxyVars } from "../src/lib/motis-feed-proxy";

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

  it("loads normalized valid feed-proxy entries and rejects invalid JSON rows", () => {
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
          valid: {
            url: " https://valid.example/rt.pb ",
            headers: { Authorization: " Bearer fixture " },
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
    expect(vars).toEqual({
      valid: {
        url: "https://valid.example/rt.pb",
        headers: { Authorization: "Bearer fixture" },
        gbfs: false,
      },
    });
  });
});
