import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OpsClient,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
} from "@openmapx/core/ops";
import { services as coreServices, gitShallowClone } from "@openmapx/core/server";
import { packageIntegration } from "@openmapx/integration-framework/installer";
import { dockerCompose } from "./docker";
import { repoPaths } from "./paths";

/**
 * Installed integrations belong to the operations agent: it alone writes
 * `custom_integrations/` and records what it installed, and it loads nothing
 * else. Its fixed CLI asks it over its own port; the host CLI runs that fixed
 * CLI in the agent's container.
 */

type IntegrationSource = coreServices.IntegrationSource;

/** Whether this is the operations agent's fixed CLI, inside its container. */
export function runsInAgent(): boolean {
  return coreServices.embeddedBuiltInIntegrationManifests() !== null;
}

function localAgentClient(): OpsClient {
  const tokenFile = process.env.OPS_AGENT_API_TOKEN_FILE?.trim();
  if (!tokenFile) throw new Error("The operations agent's token file is not configured");
  return new OpsClient({
    baseUrl: `http://127.0.0.1:${process.env.PORT?.trim() || "4300"}`,
    tokenFile,
  });
}

const operationKey = () => `opk1_${randomBytes(18).toString("base64url")}`;

async function run<K extends OpsOperationKind>(
  client: OpsClient,
  operation: Extract<OpsOperation, { kind: K }>,
): Promise<OpsResultFor<K>> {
  const submitted = await client.execute(operation, { operationKey: operationKey() });
  if (submitted.execution === "sync") return submitted.value as OpsResultFor<K>;
  for (;;) {
    const status = await client.status(operation.kind, submitted.operationId);
    if (status.state === "succeeded") return status.result as OpsResultFor<K>;
    if (status.state !== "queued" && status.state !== "running") {
      throw new Error(
        `The operations agent could not complete ${operation.kind} (${status.state})`,
      );
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

/** Install `source` as an operator integration through the local agent. */
export async function installThroughLocalAgent(source: IntegrationSource): Promise<string> {
  const client = localAgentClient();
  const inspected = await run(client, { kind: "integration.inspect", source });
  if (!inspected.valid || !inspected.integrationId) {
    throw new Error(inspected.problems.join("; ") || "The integration archive is not valid");
  }
  const published = await run(client, {
    kind: "integration.publish",
    integrationId: inspected.integrationId,
    source,
  });
  // The operator's install is complete once published; nothing else depends on it.
  await run(client, {
    kind: "integration.settle",
    integrationId: published.integrationId,
    transactionId: published.transactionId,
    outcome: "commit",
  });
  return published.integrationId;
}

export async function removeThroughLocalAgent(integrationId: string): Promise<boolean> {
  return (await run(localAgentClient(), { kind: "integration.remove", integrationId })).removed;
}

/** Whether the stack's operations agent container is running. */
export async function agentContainerRunning(): Promise<boolean> {
  const result = await dockerCompose(["ps", "--status", "running", "--services"]);
  return result.exitCode === 0 && result.stdout.split("\n").includes("ops-agent");
}

/** Run the fixed CLI in the agent's container, passing its output through. */
async function fixedCli(args: string[]): Promise<void> {
  const result = await dockerCompose(["exec", "-T", "ops-agent", "node", "dist/cli.mjs", ...args]);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  if (result.exitCode !== 0) {
    throw new Error("The operations agent did not complete the change; see its output above");
  }
}

export interface HostInstallOptions {
  source: string;
  artifact?: boolean;
  sha256?: string;
  ref?: string;
}

/**
 * Hand an install to the agent. An https artifact pinned with `--sha256` is
 * fetched by the agent itself. Anything else (a local directory, a local
 * archive or a Git source) is packaged here into an archive, which goes into
 * the agent's state directory, where only this account and the agent can
 * write; the agent records its SHA-256.
 */
export async function installThroughAgentContainer(options: HostInstallOptions): Promise<void> {
  if (/^https:\/\//.test(options.source) && options.artifact) {
    if (!options.sha256) throw new Error("An https artifact needs --sha256");
    await fixedCli([
      "integrations",
      "install",
      options.source,
      "--artifact",
      "--sha256",
      options.sha256,
    ]);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "openmapx-integration-upload-"));
  try {
    let archive: string;
    if (options.artifact) {
      archive = resolve(options.source);
      if (!statSync(archive).isFile()) throw new Error(`${options.source} is not a file`);
    } else {
      let directory = resolve(options.source);
      if (/^(github:|https:\/\/|git@)/.test(options.source)) {
        directory = await gitShallowClone({
          url: options.source.startsWith("github:")
            ? `https://github.com/${options.source.slice("github:".length)}.git`
            : options.source,
          ref: options.ref,
          targetDir: join(work, "clone"),
        });
      }
      archive = join(work, "integration.tar.gz");
      await packageIntegration({ rootDir: repoPaths().root, source: directory, outFile: archive });
    }
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (options.sha256 && options.sha256.toLowerCase() !== sha256) {
      throw new Error(`Artifact sha256 mismatch: expected ${options.sha256}, got ${sha256}`);
    }
    const uploads = coreServices.integrationUploadsDirectory(repoPaths().infraDir);
    mkdirSync(uploads, { recursive: true, mode: 0o700 });
    const upload = join(uploads, `${sha256}.tar.gz`);
    copyFileSync(archive, upload);
    try {
      await fixedCli(["integrations", "install", "--upload", sha256]);
    } finally {
      rmSync(upload, { force: true });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function removeThroughAgentContainer(integrationId: string): Promise<void> {
  await fixedCli(["integrations", "remove", integrationId]);
}
