import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectLegalTableProblems } from "./check-legal-tables.ts";

let root: string;

function writeIntegration(
  id: string,
  manifest: Record<string, unknown>,
  strings: Record<string, Record<string, unknown>>,
) {
  const dir = join(root, id);
  mkdirSync(join(dir, "strings"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, ...manifest }));
  for (const [locale, content] of Object.entries(strings)) {
    writeFileSync(join(dir, "strings", `${locale}.json`), JSON.stringify(content));
  }
}

const domainStrings = (domains: string[]) =>
  Object.fromEntries(
    domains.map((domain) => [`domain:${domain}`, { purpose: "Purpose", dataSent: "Area" }]),
  );

function problemsOf(id: string): string[] {
  const { structuralByDir, rowIssues } = collectLegalTableProblems(root);
  return [
    ...(structuralByDir.get(join(root, id)) ?? []),
    ...rowIssues
      .filter((issue) => issue.dir === join(root, id))
      .map((issue) => `${issue.source}: ${issue.missing.map((m) => m.label).join(", ")}`),
  ];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-legal-tables-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-legal-tables for a runtime integration", () => {
  const manifest = {
    domains: ["road-conditions", "fuel-stations"],
    runtimeDataSources: true,
  };

  it("check-legal-tables requires domain strings for a runtime integration", () => {
    writeIntegration("runtime-probe", manifest, {
      en: { dataSources: domainStrings(["road-conditions"]) },
      de: { dataSources: domainStrings(["road-conditions", "fuel-stations"]) },
    });
    const problems = problemsOf("runtime-probe");
    expect(problems.join("\n")).toMatch(/en: .*domain:fuel-stations/);
    expect(problems.join("\n")).not.toMatch(/de: .*domain:/);
  });

  it("requires purpose and dataSent in each domain entry", () => {
    writeIntegration("runtime-probe", manifest, {
      en: {
        dataSources: {
          ...domainStrings(["fuel-stations"]),
          "domain:road-conditions": { purpose: "Road events" },
        },
      },
      de: { dataSources: domainStrings(["road-conditions", "fuel-stations"]) },
    });
    expect(problemsOf("runtime-probe").join("\n")).toMatch(
      /en: .*domain:road-conditions.*dataSent/,
    );
  });

  it("accepts complete domain strings and lists the integration as runtime", () => {
    const both = domainStrings(["road-conditions", "fuel-stations"]);
    writeIntegration("runtime-probe", manifest, {
      en: { dataSources: both },
      de: { dataSources: both },
    });
    const result = collectLegalTableProblems(root);
    expect(problemsOf("runtime-probe")).toEqual([]);
    expect(result.runtime.map((it) => it.id)).toEqual(["runtime-probe"]);
  });

  it("rejects a domain key the manifest does not declare", () => {
    const strings = { dataSources: domainStrings(["road-conditions", "fuel-stations", "weather"]) };
    writeIntegration("runtime-probe", manifest, { en: strings, de: strings });
    expect(problemsOf("runtime-probe").join("\n")).toMatch(/domain:weather/);
  });

  it("requires a legal section heading for every declared domain", () => {
    const strings = { dataSources: domainStrings(["road-conditions", "no-such-domain"]) };
    writeIntegration(
      "runtime-probe",
      { ...manifest, domains: ["road-conditions", "no-such-domain"] },
      { en: strings, de: strings },
    );
    expect(problemsOf("runtime-probe").join("\n")).toMatch(/no-such-domain.*section key/);
  });
});

describe("check-legal-tables for a static integration", () => {
  const source = (sourceId: string, domain: string) => ({
    sourceId,
    name: sourceId,
    url: "https://source.example",
    license: "CC0-1.0",
    providerCountry: "NL",
    providerPrivacyUrl: "https://source.example/privacy",
    endUserExposure: "server-only",
    domain,
  });

  it("names the source whose row has an empty cell, across domain sections", () => {
    const strings = (locale: string) => ({
      description: `Description ${locale}`,
      dataSources: {
        "xx-road-events": { purpose: "Road", dataSent: "Area" },
        "xx-fuel-prices": { purpose: "Fuel" },
        "xx-more-road-events": { purpose: "Road", dataSent: "Area" },
      },
    });
    writeIntegration(
      "static-probe",
      {
        domains: ["road-conditions", "fuel-stations"],
        dataSources: [
          source("xx-road-events", "road-conditions"),
          source("xx-fuel-prices", "fuel-stations"),
          source("xx-more-road-events", "road-conditions"),
        ],
      },
      { en: strings("en"), de: strings("de") },
    );
    expect(problemsOf("static-probe")).toEqual([
      "xx-fuel-prices: Data Transmitted",
      "xx-fuel-prices: Data Transmitted",
    ]);
  });
});
