import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Changesets release configuration", () => {
  it("keeps versioning private workspace packages under Changesets v3", () => {
    const config = JSON.parse(read(".changeset/config.json")) as {
      privatePackages?: { tag?: boolean; version?: boolean };
    };

    expect(config.privatePackages).toEqual({ version: true, tag: false });
  });

  it("uses the Changesets v2 action API and passes the release token as an input", () => {
    const workflow = read(".github/workflows/release.yml");

    expect(workflow).toContain(
      "changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51 # v2.1.2",
    );
    expect(workflow).toContain("github-token: $" + "{{ secrets.GITHUB_TOKEN }}");
    expect(workflow).toContain("version-script: pnpm exec changeset version");
    expect(workflow).toContain('commit-message: "chore: version packages"');
    expect(workflow).toContain('pr-title: "chore: version packages"');
    expect(workflow).toContain("create-github-releases: true");
    expect(workflow).not.toMatch(/^\s+(version|commit|title|createGithubReleases):/m);
    expect(workflow).not.toContain("GITHUB_TOKEN:");
  });
});
