/** A fake Docker engine for the crash-point suite. Every `docker` invocation of
 * every role arrives here through the shim, is recorded in the trace, and is
 * answered from a small model of images, a registry and containers. Compose
 * files are interpreted by the real `docker compose config`, so services,
 * images, environments and config hashes are the ones Compose would use.
 * Fault rules can hold an invocation (a deterministic "effect started"
 * moment), fail it, or report a recreated service as unhealthy. */
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, posix } from "node:path";
import { renderGoTemplate } from "./go-template";

export interface Invocation {
  seq: number;
  caller: string;
  args: string[];
  cwd: string;
  at: number;
  code?: number;
  /** Set once the engine applied the invocation's effect (or answered it). */
  done: boolean;
}

interface Request {
  args: string[];
  cwd: string;
  pid: number;
  caller: string;
  env: Record<string, string>;
  stdin: string;
}

interface Answer {
  stdout?: string;
  stderr?: string;
  code: number;
}

export interface FaultRule {
  readonly id: number;
  readonly entered: Promise<Invocation>;
  /** Lets a held invocation continue; `fail` answers it with an error instead. */
  release(options?: { fail?: string }): void;
  /** How many invocations matched so far. */
  readonly hits: number;
}

interface Rule {
  id: number;
  match: (invocation: Invocation) => boolean;
  kind: "hold" | "fail";
  skip: number;
  times: number;
  hits: number;
  message: string;
  entered: PromiseWithResolvers<Invocation>;
  released: PromiseWithResolvers<{ fail?: string }>;
  onEnter?: (invocation: Invocation) => Promise<void> | void;
}

export interface ImageRecord {
  Id: string;
  RepoTags: string[];
  RepoDigests: string[];
  Labels: Record<string, string>;
  /** Bytes served by `docker cp` from this image's containers, by container path. */
  files: Record<string, string>;
  healthcheck: boolean;
}

export interface ContainerRecord {
  Id: string;
  Name: string;
  Created: string;
  Image: string;
  Config: {
    Image: string;
    Labels: Record<string, string>;
    Env: string[];
    User: string;
    Hostname: string;
    Cmd: string[];
    Entrypoint: string[] | null;
  };
  State: {
    Status: string;
    Running: boolean;
    Pid: number;
    ExitCode: number;
    StartedAt: string;
    FinishedAt: string;
    Health?: { Status: string };
  };
  HostConfig: {
    Memory: number;
    NanoCpus: number;
    GroupAdd: string[] | null;
    RestartPolicy: { Name: string };
  };
  Mounts: Array<{
    Type: string;
    Name?: string;
    Source: string;
    Destination: string;
    RW: boolean;
    Mode: string;
  }>;
  /** Not part of Docker's answer: the compose service and whether it is a role process. */
  service?: string;
}

export interface EngineHooks {
  /** The real Docker CLI, for `compose config` only. */
  realDocker: string;
  /** A role service was (re)created or started: run its process. */
  startRole(service: string, container: ContainerRecord): Promise<void>;
  /** A role service was stopped or removed: end its process. */
  stopRole(service: string): Promise<void>;
  /** Whether a role service's process is up and answering. */
  roleState(service: string): "running" | "starting" | "exited";
  /** `docker run` of an image's command, such as the configuration helper. */
  runContainer(
    container: ContainerRecord,
    request: Request,
  ): { exited: Promise<{ code: number; stdout: string; stderr: string }> };
}

export const ROLE_SERVICES = new Set(["app-api", "data-manager", "ops-agent"]);
const PROJECT = "openmapx";

function hex(seed: string, length = 64): string {
  let out = "";
  let counter = 0;
  while (out.length < length)
    out += createHash("sha256").update(`${seed}:${counter++}`).digest("hex");
  return out.slice(0, length);
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function now(): string {
  return new Date().toISOString();
}

/** Splits `repo:tag` or `repo@digest` into the repository and the selector. */
function parseReference(reference: string): { repository: string; tag?: string; digest?: string } {
  const at = reference.indexOf("@");
  if (at >= 0) {
    const named = reference.slice(0, at);
    const colon = named.lastIndexOf(":");
    const repository = colon > named.lastIndexOf("/") ? named.slice(0, colon) : named;
    return { repository, digest: reference.slice(at + 1) };
  }
  const colon = reference.lastIndexOf(":");
  if (colon > reference.lastIndexOf("/"))
    return { repository: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  return { repository: reference, tag: "latest" };
}

export class FakeDockerEngine {
  readonly trace: Invocation[] = [];
  readonly unsupported: string[] = [];
  readonly images = new Map<string, ImageRecord>();
  /** Local reference (`repo:tag`, `repo@digest`, or the image id) to image id. */
  readonly references = new Map<string, string>();
  /** Registry content: `repo:tag` and `repo@digest` to the image and its OCI digest. */
  readonly registry = new Map<string, { imageId: string; digest: string }>();
  readonly containers = new Map<string, ContainerRecord>();
  registryDown = false;
  /** Services whose next (re)created container reports unhealthy. */
  readonly unhealthyServices = new Set<string>();
  private rules: Rule[] = [];
  private ruleCounter = 0;
  private server?: Server;
  private sequence = 0;
  private composeQueue: Promise<unknown> = Promise.resolve();
  url = "";
  private readonly secret = randomBytes(24).toString("hex");
  /** Where named volumes of created containers are backed on the host. */
  volumeRoot = "/tmp";
  /** Where each answered invocation is appended, for diagnosing a failed run. */
  traceFile?: string;

  constructor(private readonly hooks: EngineHooks) {}

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    this.server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/${this.secret}/`;
    return this.url;
  }

  private closed = false;

  async close(): Promise<void> {
    this.closed = true;
    for (const rule of this.rules) rule.released.resolve({ fail: "engine closed" });
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Adds an image to the registry under each reference; returns its id. */
  publishImage(
    references: string[],
    options: {
      labels?: Record<string, string>;
      files?: Record<string, string>;
      healthcheck?: boolean;
    } = {},
  ): { imageId: string; digest: string } {
    const imageId = `sha256:${hex(`image:${references.join(",")}:${JSON.stringify(options.labels ?? {})}:${randomBytes(4).toString("hex")}`)}`;
    const digest = `sha256:${hex(`digest:${imageId}`)}`;
    this.images.set(imageId, {
      Id: imageId,
      RepoTags: [],
      RepoDigests: [],
      Labels: options.labels ?? {},
      files: options.files ?? {},
      healthcheck: options.healthcheck ?? true,
    });
    for (const reference of references) {
      const { repository } = parseReference(reference);
      this.registry.set(reference, { imageId, digest });
      this.registry.set(`${repository}@${digest}`, { imageId, digest });
    }
    return { imageId, digest };
  }

  /** Makes a published image local, as if it had been pulled before. */
  preload(reference: string): string {
    const entry = this.registry.get(reference);
    if (!entry) throw new Error(`Unknown registry reference ${reference}`);
    this.localize(reference, entry);
    return entry.imageId;
  }

  /** Moves a tag in the registry to another image (a new release). */
  retag(reference: string, imageId: string): void {
    const digest = `sha256:${hex(`digest:${imageId}`)}`;
    this.registry.set(reference, { imageId, digest });
  }

  hold(
    match: (invocation: Invocation) => boolean,
    options: { skip?: number; times?: number; onEnter?: Rule["onEnter"] } = {},
  ): FaultRule {
    return this.addRule("hold", match, options);
  }

  fail(
    match: (invocation: Invocation) => boolean,
    options: { skip?: number; times?: number; message?: string } = {},
  ): FaultRule {
    return this.addRule("fail", match, options);
  }

  private addRule(
    kind: Rule["kind"],
    match: Rule["match"],
    options: { skip?: number; times?: number; message?: string; onEnter?: Rule["onEnter"] },
  ): FaultRule {
    const rule: Rule = {
      id: ++this.ruleCounter,
      match,
      kind,
      skip: options.skip ?? 0,
      times: options.times ?? 1,
      hits: 0,
      message: options.message ?? "Error response from daemon: injected failure",
      entered: Promise.withResolvers(),
      released: Promise.withResolvers(),
      onEnter: options.onEnter,
    };
    this.rules.push(rule);
    return {
      id: rule.id,
      entered: rule.entered.promise,
      release: (value = {}) => rule.released.resolve(value),
      get hits() {
        return rule.hits;
      },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    // Only processes this host started know the engine's path; any other local
    // process is refused before the engine starts anything on its behalf.
    const expected = Buffer.from(`/${this.secret}/invoke`);
    const presented = Buffer.from(request.url ?? "");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let parsed: Request;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Request;
    } catch {
      response.writeHead(400).end();
      return;
    }
    const invocation: Invocation = {
      seq: ++this.sequence,
      caller: parsed.caller,
      args: parsed.args,
      cwd: parsed.cwd,
      at: Date.now(),
      done: false,
    };
    this.trace.push(invocation);
    let answer: Answer;
    try {
      answer = await this.applyRules(invocation, () => this.execute(parsed, invocation));
    } catch (error) {
      answer = { code: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
    }
    invocation.code = answer.code;
    invocation.done = true;
    // A call answered while the host is being removed has nowhere to be logged.
    if (this.traceFile && !this.closed)
      try {
        appendFileSync(
          this.traceFile,
          `${JSON.stringify({ seq: invocation.seq, caller: invocation.caller, args: invocation.args, code: answer.code, stderr: answer.code ? answer.stderr?.slice(0, 2000) : undefined, stdout: (answer.stdout ?? "").slice(0, 300) })}\n`,
        );
      } catch {
        // The trace file is diagnostics only.
      }
    const body = JSON.stringify(answer);
    if (!response.destroyed)
      response.writeHead(200, { "content-type": "application/json" }).end(body);
  }

  private async applyRules(invocation: Invocation, run: () => Promise<Answer>): Promise<Answer> {
    for (const rule of this.rules) {
      if (rule.times <= 0 || !rule.match(invocation)) continue;
      rule.hits++;
      if (rule.skip > 0) {
        rule.skip--;
        continue;
      }
      rule.times--;
      if (rule.kind === "fail") {
        rule.entered.resolve(invocation);
        return { code: 1, stderr: `${rule.message}\n` };
      }
      await rule.onEnter?.(invocation);
      rule.entered.resolve(invocation);
      const { fail } = await rule.released.promise;
      if (fail) return { code: 1, stderr: `${fail}\n` };
      return run();
    }
    return run();
  }

  private unsupportedAnswer(args: string[]): Answer {
    const line = args.join(" ");
    this.unsupported.push(line);
    return { code: 125, stderr: `crash-point engine: unsupported docker invocation: ${line}\n` };
  }

  private async execute(request: Request, _invocation: Invocation): Promise<Answer> {
    const args = [...request.args];
    while (args[0]?.startsWith("--") && args[0] !== "--version") {
      // Global client flags such as --log-level.
      args.splice(0, args[0].includes("=") ? 1 : 2);
    }
    const [command, ...rest] = args;
    switch (command) {
      case "compose":
        return this.compose(rest, request);
      case "version":
      case "--version":
        return { code: 0, stdout: "Docker version 29.0.0-crash-point\n" };
      case "info":
        return this.info(rest);
      case "ps":
        return this.list(rest);
      case "container":
        return this.container(rest, request);
      case "image":
        return this.image(rest);
      case "inspect":
        return this.inspectAny(rest);
      case "manifest":
        if (rest[0] === "inspect") return this.manifestInspect(rest.slice(1));
        return this.unsupportedAnswer(request.args);
      case "pull":
        return this.pull(rest);
      case "create":
        return this.createPlain(rest);
      case "cp":
        return this.copy(rest);
      case "rm":
        return this.remove(rest);
      case "run":
        return this.run(rest, request);
      case "wait":
        return this.wait(rest);
      case "logs":
        return { code: 0, stdout: "" };
      case "stop":
      case "kill":
        return this.stopContainers(rest);
      case "start":
        return this.startContainers(rest);
      case "restart":
        await this.stopContainers(rest);
        return this.startContainers(rest);
      default:
        return this.unsupportedAnswer(request.args);
    }
  }

  private info(args: string[]): Answer {
    const format = flagValue(args, "--format") ?? flagValue(args, "-f");
    const info = {
      OSType: "linux",
      Architecture: "x86_64",
      ServerVersion: "29.0.0",
      ID: "CRASH:POINT",
      Name: "crash-point",
    };
    return {
      code: 0,
      stdout: format ? `${renderGoTemplate(format, info)}\n` : JSON.stringify(info),
    };
  }

  private container(args: string[], request: Request): Promise<Answer> | Answer {
    const [sub, ...rest] = args;
    switch (sub) {
      case "ls":
      case "list":
      case "ps":
        return this.list(rest);
      case "inspect":
        return this.inspectContainers(rest);
      case "rm":
        return this.remove(rest);
      case "stop":
      case "kill":
        return this.stopContainers(rest);
      case "start":
        return this.startContainers(rest);
      case "wait":
        return this.wait(rest);
      case "logs":
        return { code: 0, stdout: "" };
      case "create":
        return this.createPlain(rest);
      case "run":
        return this.run(rest, request);
      default:
        return this.unsupportedAnswer(request.args);
    }
  }

  private image(args: string[]): Answer | Promise<Answer> {
    const [sub, ...rest] = args;
    if (sub === "inspect") return this.inspectImages(rest);
    if (sub === "pull") return this.pull(rest);
    if (sub === "ls") return { code: 0, stdout: "" };
    if (sub === "rm") return { code: 0, stdout: "" };
    return this.unsupportedAnswer(["image", ...args]);
  }

  private liveState(container: ContainerRecord): ContainerRecord {
    if (
      container.service &&
      ROLE_SERVICES.has(container.service) &&
      container.State.Status !== "exited" &&
      container.State.Status !== "created"
    ) {
      const state = this.hooks.roleState(container.service);
      const running = state !== "exited";
      container.State.Running = running;
      container.State.Status = running ? "running" : "restarting";
      if (container.State.Health && container.State.Health.Status !== "unhealthy")
        container.State.Health.Status = state === "running" ? "healthy" : "starting";
    }
    return container;
  }

  private findContainer(reference: string): ContainerRecord | undefined {
    const direct = this.containers.get(reference);
    if (direct) return this.liveState(direct);
    for (const container of this.containers.values()) {
      if (
        container.Name === `/${reference}` ||
        container.Name === reference ||
        (reference.length >= 12 && container.Id.startsWith(reference))
      )
        return this.liveState(container);
    }
    return undefined;
  }

  private filterContainers(args: string[]): ContainerRecord[] {
    const all = args.includes("-a") || args.includes("--all");
    const filters = flagValues(args, "--filter").concat(flagValues(args, "-f"));
    return [...this.containers.values()]
      .map((container) => this.liveState(container))
      .filter((container) => all || container.State.Running)
      .filter((container) =>
        filters.every((filter) => {
          const [key, ...value] = filter.split("=");
          const expected = value.join("=");
          if (key === "label") {
            const [name, ...labelValue] = expected.split("=");
            const actual = container.Config.Labels[name as string];
            return labelValue.length ? actual === labelValue.join("=") : actual !== undefined;
          }
          if (key === "name") return container.Name.replace(/^\//, "").includes(expected);
          if (key === "id") return container.Id.startsWith(expected);
          if (key === "status") return container.State.Status === expected;
          if (key === "ancestor")
            return container.Config.Image === expected || container.Image === expected;
          throw new Error(`Unsupported container filter ${filter}`);
        }),
      );
  }

  private list(args: string[]): Answer {
    const containers = this.filterContainers(args);
    const quiet = args.includes("-q") || args.includes("--quiet");
    const truncate = !args.includes("--no-trunc");
    const format = flagValue(args, "--format");
    if (quiet)
      return {
        code: 0,
        stdout: containers.map((c) => `${truncate ? c.Id.slice(0, 12) : c.Id}\n`).join(""),
      };
    const rows = containers.map((c) => ({
      ID: truncate ? c.Id.slice(0, 12) : c.Id,
      Names: c.Name.replace(/^\//, ""),
      Image: c.Config.Image,
      State: c.State.Status,
      Status: c.State.Running ? "Up 1 minute" : "Exited (0) 1 minute ago",
      Labels: Object.entries(c.Config.Labels)
        .map(([key, value]) => `${key}=${value}`)
        .join(","),
      CreatedAt: c.Created,
    }));
    if (!format || format === "json" || format === "{{json .}}")
      return { code: 0, stdout: rows.map((row) => `${JSON.stringify(row)}\n`).join("") };
    return { code: 0, stdout: rows.map((row) => `${renderGoTemplate(format, row)}\n`).join("") };
  }

  private inspectContainers(args: string[]): Answer {
    const format = flagValue(args, "--format") ?? flagValue(args, "-f");
    const ids = positional(args, ["--format", "-f", "--type"]);
    const found: ContainerRecord[] = [];
    for (const id of ids) {
      const container = this.findContainer(id);
      if (!container)
        return {
          code: 1,
          stdout: format ? "" : "[]\n",
          stderr: `Error: No such container: ${id}\n`,
        };
      found.push(container);
    }
    return this.renderObjects(found.map(publicContainer), format);
  }

  private inspectAny(args: string[]): Answer {
    const type = flagValue(args, "--type");
    if (type === "image") return this.inspectImages(args);
    const ids = positional(args, ["--format", "-f", "--type"]);
    if (type !== "container" && ids.every((id) => this.resolveImage(id)))
      return this.inspectImages(args);
    return this.inspectContainers(args);
  }

  private renderObjects(objects: unknown[], format?: string): Answer {
    if (!format) return { code: 0, stdout: `${JSON.stringify(objects, null, 4)}\n` };
    return {
      code: 0,
      stdout: objects.map((value) => `${renderGoTemplate(format, value)}\n`).join(""),
    };
  }

  private resolveImage(reference: string): ImageRecord | undefined {
    const id =
      this.references.get(reference) ?? (this.images.has(reference) ? reference : undefined);
    if (!id) return undefined;
    const record = this.images.get(id);
    if (!record) return undefined;
    // Only images present locally answer an inspect.
    return this.references.has(reference) || record.RepoTags.length || record.RepoDigests.length
      ? record
      : undefined;
  }

  private inspectImages(args: string[]): Answer {
    const format = flagValue(args, "--format") ?? flagValue(args, "-f");
    const references = positional(args, ["--format", "-f", "--type"]);
    const found: unknown[] = [];
    for (const reference of references) {
      const image = this.resolveImage(reference);
      if (!image)
        return {
          code: 1,
          stdout: format ? "" : "[]\n",
          stderr: `Error: No such image: ${reference}\n`,
        };
      found.push({
        Id: image.Id,
        RepoTags: image.RepoTags,
        RepoDigests: image.RepoDigests,
        Os: "linux",
        Architecture: "amd64",
        Config: { Labels: image.Labels },
      });
    }
    return this.renderObjects(found, format);
  }

  private manifestInspect(args: string[]): Answer {
    const reference = positional(args, ["--insecure"]).at(-1) ?? "";
    if (this.registryDown)
      return {
        code: 1,
        stderr: `Get "https://${reference.split("/")[0]}/v2/": dial tcp: connection refused\n`,
      };
    const entry = this.registry.get(reference);
    if (!entry) return { code: 1, stderr: `no such manifest: ${reference}\n` };
    return {
      code: 0,
      stdout: JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: entry.imageId,
          size: 1024,
        },
        layers: [
          {
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
            digest: `sha256:${hex(`layer:${entry.imageId}`)}`,
            size: 4096,
          },
        ],
      }),
    };
  }

  private localize(reference: string, entry: { imageId: string; digest: string }) {
    const image = this.images.get(entry.imageId);
    if (!image) throw new Error(`Registry image ${entry.imageId} is unknown`);
    const { repository, tag } = parseReference(reference);
    const byDigest = `${repository}@${entry.digest}`;
    this.references.set(reference, entry.imageId);
    this.references.set(byDigest, entry.imageId);
    this.references.set(entry.imageId, entry.imageId);
    if (!image.RepoDigests.includes(byDigest)) image.RepoDigests.push(byDigest);
    if (tag && !image.RepoTags.includes(`${repository}:${tag}`)) {
      for (const other of this.images.values())
        other.RepoTags = other.RepoTags.filter((value) => value !== `${repository}:${tag}`);
      image.RepoTags.push(`${repository}:${tag}`);
    }
  }

  private pull(args: string[]): Answer {
    const reference = positional(args, ["--platform", "-q", "--quiet"]).at(-1) ?? "";
    if (this.registryDown)
      return {
        code: 1,
        stderr: `Error response from daemon: Get "https://${reference.split("/")[0]}/v2/": dial tcp: connection refused\n`,
      };
    const entry = this.registry.get(reference);
    if (!entry)
      return { code: 1, stderr: `Error response from daemon: manifest unknown: ${reference}\n` };
    this.localize(reference, entry);
    const { tag } = parseReference(reference);
    return {
      code: 0,
      stdout: `${tag ?? "digest"}: Pulling from ${parseReference(reference).repository}\nDigest: ${entry.digest}\nStatus: Downloaded newer image for ${reference}\n${reference}\n`,
    };
  }

  private newContainer(input: {
    name: string;
    imageId: string;
    imageReference: string;
    labels: Record<string, string>;
    env: string[];
    user?: string;
    groups?: string[] | null;
    mounts?: ContainerRecord["Mounts"];
    cmd?: string[];
    service?: string;
    memory?: number;
    nanoCpus?: number;
  }): ContainerRecord {
    const image = this.images.get(input.imageId);
    const id = hex(`container:${input.name}:${randomBytes(8).toString("hex")}`);
    const container: ContainerRecord = {
      Id: id,
      Name: `/${input.name}`,
      Created: now(),
      Image: input.imageId,
      Config: {
        Image: input.imageReference,
        Labels: { ...(image?.Labels ?? {}), ...input.labels },
        Env: input.env,
        User: input.user ?? "",
        Hostname: id.slice(0, 12),
        Cmd: input.cmd ?? [],
        Entrypoint: null,
      },
      State: {
        Status: "created",
        Running: false,
        Pid: 0,
        ExitCode: 0,
        StartedAt: "0001-01-01T00:00:00Z",
        FinishedAt: "0001-01-01T00:00:00Z",
        ...(image?.healthcheck ? { Health: { Status: "starting" } } : {}),
      },
      HostConfig: {
        Memory: input.memory ?? 0,
        NanoCpus: input.nanoCpus ?? 0,
        GroupAdd: input.groups ?? null,
        RestartPolicy: { Name: "unless-stopped" },
      },
      Mounts: input.mounts ?? [],
      ...(input.service ? { service: input.service } : {}),
    };
    this.containers.set(id, container);
    return container;
  }

  private markRunning(container: ContainerRecord) {
    container.State.Status = "running";
    container.State.Running = true;
    container.State.Pid = 1000 + (this.sequence % 50000);
    container.State.StartedAt = now();
    if (container.State.Health) {
      const unhealthy = container.service && this.unhealthyServices.has(container.service);
      container.State.Health.Status = unhealthy ? "unhealthy" : "healthy";
    }
  }

  private markExited(container: ContainerRecord, code = 0) {
    container.State.Status = "exited";
    container.State.Running = false;
    container.State.Pid = 0;
    container.State.ExitCode = code;
    container.State.FinishedAt = now();
  }

  private createPlain(args: string[]): Answer {
    const image = positional(args, ["--name", "--label", "--entrypoint"])[0] ?? "";
    const record = this.resolveImage(image);
    if (!record) return { code: 1, stderr: `Unable to find image '${image}' locally\n` };
    const container = this.newContainer({
      name: flagValue(args, "--name") ?? `crash_${randomBytes(4).toString("hex")}`,
      imageId: record.Id,
      imageReference: image,
      labels: {},
      env: [],
    });
    return { code: 0, stdout: `${container.Id}\n` };
  }

  private copy(args: string[]): Answer {
    const [from, to] = positional(args, ["-a", "-L"]);
    if (!from || !to) return this.unsupportedAnswer(["cp", ...args]);
    const separator = from.indexOf(":");
    const container = this.findContainer(from.slice(0, separator));
    if (!container) return { code: 1, stderr: `Error: No such container:path: ${from}\n` };
    const bytes = this.images.get(container.Image)?.files[from.slice(separator + 1)];
    if (bytes === undefined)
      return {
        code: 1,
        stderr: `Error: Could not find the file ${from.slice(separator + 1)} in container\n`,
      };
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes, { mode: 0o600 });
    return { code: 0, stdout: "" };
  }

  private async remove(args: string[]): Promise<Answer> {
    const ids = positional(args, []).filter((value) => !value.startsWith("-"));
    for (const id of ids) {
      const container = this.findContainer(id);
      if (!container) {
        if (args.includes("-f") || args.includes("--force")) continue;
        return { code: 1, stderr: `Error response from daemon: No such container: ${id}\n` };
      }
      if (container.service && ROLE_SERVICES.has(container.service))
        await this.hooks.stopRole(container.service);
      this.containers.delete(container.Id);
    }
    return { code: 0, stdout: `${ids.join("\n")}\n` };
  }

  private async stopContainers(args: string[]): Promise<Answer> {
    const ids = positional(args, ["-t", "--time", "-s", "--signal"]);
    for (const id of ids) {
      const container = this.findContainer(id);
      if (!container)
        return { code: 1, stderr: `Error response from daemon: No such container: ${id}\n` };
      if (container.service && ROLE_SERVICES.has(container.service))
        await this.hooks.stopRole(container.service);
      this.markExited(container, 0);
    }
    return { code: 0, stdout: `${ids.join("\n")}\n` };
  }

  private async startContainers(args: string[]): Promise<Answer> {
    const ids = positional(args, ["-a"]);
    for (const id of ids) {
      const container = this.findContainer(id);
      if (!container)
        return { code: 1, stderr: `Error response from daemon: No such container: ${id}\n` };
      this.markRunning(container);
      if (container.service && ROLE_SERVICES.has(container.service))
        await this.hooks.startRole(container.service, container);
    }
    return { code: 0, stdout: `${ids.join("\n")}\n` };
  }

  private async wait(args: string[]): Promise<Answer> {
    const ids = positional(args, []);
    const codes: number[] = [];
    for (const id of ids) {
      const container = this.findContainer(id);
      if (!container)
        return { code: 1, stderr: `Error response from daemon: No such container: ${id}\n` };
      const helper = this.helpers.get(container.Id);
      if (helper) await helper;
      codes.push(container.State.ExitCode);
    }
    return { code: 0, stdout: codes.map((code) => `${code}\n`).join("") };
  }

  private readonly helpers = new Map<string, Promise<number>>();

  private run(args: string[], request: Request): Answer | Promise<Answer> {
    const valueFlags = [
      "--name",
      "--label",
      "--user",
      "-u",
      "--group-add",
      "--env",
      "-e",
      "--volume",
      "-v",
      "--mount",
      "--entrypoint",
      "--workdir",
      "-w",
      "--network",
      "--restart",
      "--memory",
      "--cpus",
      "--pull",
      "--log-driver",
      "--log-opt",
      "--stop-timeout",
      "--security-opt",
      "--cap-drop",
      "--cap-add",
      "--tmpfs",
      "--hostname",
      "--pids-limit",
      "--ulimit",
    ];
    const booleanFlags = new Set([
      "-d",
      "--detach",
      "--rm",
      "--init",
      "--read-only",
      "-i",
      "-t",
      "--interactive",
      "--tty",
      "--privileged",
    ]);
    let index = 0;
    const values: Record<string, string[]> = {};
    const detached = args.includes("-d") || args.includes("--detach");
    const removeAfter = args.includes("--rm");
    const add = (flag: string, value: string) => {
      values[flag] = [...(values[flag] ?? []), value];
    };
    while (index < args.length) {
      const arg = args[index] as string;
      if (!arg.startsWith("-")) break;
      if (booleanFlags.has(arg)) {
        index++;
        continue;
      }
      const eq = arg.indexOf("=");
      if (eq > 0 && valueFlags.includes(arg.slice(0, eq))) {
        add(arg.slice(0, eq), arg.slice(eq + 1));
        index++;
        continue;
      }
      if (!valueFlags.includes(arg)) return this.unsupportedAnswer(["run", ...args]);
      add(arg, args[index + 1] as string);
      index += 2;
    }
    const imageReference = args[index] as string;
    const cmd = args.slice(index + 1);
    // `docker run` pulls a missing image first, as `--pull missing` does.
    if (
      !this.resolveImage(imageReference) &&
      values["--pull"]?.[0] !== "never" &&
      !this.registryDown
    ) {
      const entry = this.registry.get(imageReference);
      if (entry) this.localize(imageReference, entry);
    }
    const image = this.resolveImage(imageReference);
    if (!image) return { code: 125, stderr: `Unable to find image '${imageReference}' locally\n` };
    const name = values["--name"]?.[0] ?? `crash_${randomBytes(4).toString("hex")}`;
    if ([...this.containers.values()].some((c) => c.Name === `/${name}`))
      return {
        code: 125,
        stderr: `docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.\n`,
      };
    const labels = Object.fromEntries(
      (values["--label"] ?? []).map((label) => {
        const eq = label.indexOf("=");
        return eq < 0 ? [label, ""] : [label.slice(0, eq), label.slice(eq + 1)];
      }),
    );
    const mounts: ContainerRecord["Mounts"] = [];
    for (const volume of [...(values["--volume"] ?? []), ...(values["-v"] ?? [])]) {
      const [source, destination, mode] = volume.split(":");
      mounts.push({
        Type: "bind",
        Source: source as string,
        Destination: destination as string,
        RW: mode !== "ro",
        Mode: mode ?? "",
      });
    }
    for (const mount of values["--mount"] ?? []) {
      const fields = Object.fromEntries(
        mount.split(",").map((part) => {
          const eq = part.indexOf("=");
          return eq < 0 ? [part, "true"] : [part.slice(0, eq), part.slice(eq + 1)];
        }),
      );
      mounts.push({
        Type: fields.type ?? "bind",
        Source: fields.source ?? fields.src ?? "",
        Destination: fields.target ?? fields.destination ?? fields.dst ?? "",
        RW: !(fields.readonly === "true" || fields.ro === "true" || fields.readonly === "1"),
        Mode: "",
      });
    }
    const duplicate = duplicateMountPoint(mounts);
    if (duplicate)
      return {
        code: 125,
        stderr: `docker: Error response from daemon: Duplicate mount point: ${duplicate}\n\nRun 'docker run --help' for more information\n`,
      };
    const env = [...(values["--env"] ?? []), ...(values["-e"] ?? [])];
    const container = this.newContainer({
      name,
      imageId: image.Id,
      imageReference,
      labels,
      env,
      user: values["--user"]?.[0] ?? values["-u"]?.[0],
      groups: values["--group-add"] ?? null,
      mounts,
      cmd,
    });
    if (values["--entrypoint"]?.[0]) container.Config.Entrypoint = [values["--entrypoint"][0]];
    this.markRunning(container);
    const { exited } = this.hooks.runContainer(container, request);
    const finished = exited.then((result) => {
      this.markExited(container, result.code);
      return result;
    });
    this.helpers.set(
      container.Id,
      finished.then((result) => result.code),
    );
    if (detached) return { code: 0, stdout: `${container.Id}\n` };
    return finished.then((result) => {
      if (removeAfter) this.containers.delete(container.Id);
      return result;
    });
  }

  private async compose(args: string[], request: Request): Promise<Answer> {
    const global: string[] = [];
    let index = 0;
    const globalValue = new Set([
      "-p",
      "--project-name",
      "-f",
      "--file",
      "--project-directory",
      "--env-file",
      "--profile",
      "--ansi",
      "--progress",
      "--parallel",
    ]);
    while (index < args.length && (args[index] as string).startsWith("-")) {
      const arg = args[index] as string;
      if (globalValue.has(arg)) {
        global.push(arg, args[index + 1] as string);
        index += 2;
      } else if (arg.includes("=") && globalValue.has(arg.slice(0, arg.indexOf("=")))) {
        global.push(arg);
        index++;
      } else if (arg === "--dry-run" || arg === "--compatibility") {
        global.push(arg);
        index++;
      } else return this.unsupportedAnswer(["compose", ...args]);
    }
    const sub = args[index];
    const rest = args.slice(index + 1);
    if (sub === "config") return this.realCompose([...global, "config", ...rest], request);
    if (sub === "version") return { code: 0, stdout: "Docker Compose version v2.40.3\n" };
    // Mutating compose commands of different callers never interleave, as in
    // Docker where each container operation is atomic on the daemon.
    const run = async () => {
      switch (sub) {
        case "up":
        case "create":
          return this.composeUp(global, rest, request, sub === "create");
        case "ps":
          return this.composePs(global, rest, request);
        case "stop":
        case "kill":
          return this.composeStop(global, rest, request);
        case "start":
          return this.composeStart(global, rest, request);
        case "restart":
          await this.composeStop(global, rest, request);
          return this.composeStart(global, rest, request);
        case "rm":
        case "down":
          return this.composeRemove(global, rest, request);
        case "pull":
          return this.composePull(global, rest, request);
        default:
          return this.unsupportedAnswer(["compose", ...args]);
      }
    };
    const result = this.composeQueue.then(run, run);
    this.composeQueue = result.catch(() => undefined);
    return result;
  }

  private realCompose(args: string[], request: Request): Promise<Answer> {
    return new Promise((resolve) => {
      execFile(
        this.hooks.realDocker,
        ["compose", ...args],
        {
          cwd: request.cwd,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: process.env.HOME ?? "/tmp",
            ...request.env,
          },
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }

  private async composeModel(global: string[], request: Request) {
    const config = await this.realCompose([...global, "config", "--format", "json"], request);
    if (config.code !== 0) throw new Error(config.stderr ?? "compose config failed");
    const hashes = await this.realCompose([...global, "config", "--hash", "*"], request);
    if (hashes.code !== 0) throw new Error(hashes.stderr ?? "compose config --hash failed");
    const model = JSON.parse(config.stdout ?? "{}") as ComposeModel;
    const hash = new Map(
      (hashes.stdout ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [service, value] = line.trim().split(/\s+/);
          return [service as string, value as string];
        }),
    );
    const files = flagValuesFrom(global, ["-f", "--file"]);
    const directory =
      flagValuesFrom(global, ["--project-directory"])[0] ??
      (files[0] ? dirname(files[0]) : request.cwd);
    return {
      model,
      hash,
      files,
      directory,
      project: flagValuesFrom(global, ["-p", "--project-name"])[0] ?? model.name ?? PROJECT,
    };
  }

  private composeContainers(project: string, service?: string): ContainerRecord[] {
    return [...this.containers.values()]
      .map((container) => this.liveState(container))
      .filter(
        (container) =>
          container.Config.Labels["com.docker.compose.project"] === project &&
          (!service || container.Config.Labels["com.docker.compose.service"] === service),
      );
  }

  private async composeUp(
    global: string[],
    args: string[],
    request: Request,
    createOnly: boolean,
  ): Promise<Answer> {
    const valueFlags = new Set([
      "--pull",
      "-t",
      "--timeout",
      "--wait-timeout",
      "--scale",
      "--exit-code-from",
      "--attach",
      "--no-attach",
    ]);
    const services: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (valueFlags.has(arg)) i++;
      else if (!arg.startsWith("-")) services.push(arg);
    }
    const force = args.includes("--force-recreate");
    const noRecreate = args.includes("--no-recreate");
    const noStart = args.includes("--no-start") || createOnly;
    const pullNever = flagValue(args, "--pull") === "never";
    const { model, hash, files, directory, project } = await this.composeModel(global, request);
    const selected = services.length ? services : Object.keys(model.services);
    const messages: string[] = [];
    for (const name of selected) {
      const spec = model.services[name];
      if (!spec) return { code: 1, stderr: `no such service: ${name}\n` };
      let imageId = this.references.get(spec.image);
      if (!imageId) {
        const entry = !pullNever && !this.registryDown ? this.registry.get(spec.image) : undefined;
        if (!entry)
          return {
            code: 1,
            stderr: `Error response from daemon: pull access denied for ${spec.image}, repository does not exist or may require 'docker login'\n`,
          };
        this.localize(spec.image, entry);
        imageId = entry.imageId;
      }
      const existing = this.composeContainers(project, name);
      const current = existing[0];
      const configHash = hash.get(name) ?? "";
      const unchanged =
        current &&
        current.Image === imageId &&
        current.Config.Labels["com.docker.compose.config-hash"] === configHash;
      if (current && (noRecreate || (unchanged && !force))) {
        if (!noStart && !current.State.Running) {
          this.markRunning(current);
          if (ROLE_SERVICES.has(name)) await this.hooks.startRole(name, current);
          messages.push(`Container ${current.Name.slice(1)} Started`);
        } else messages.push(`Container ${current.Name.slice(1)} Running`);
        continue;
      }
      // The daemon refuses the new container before the old one is replaced.
      const mounts = this.composeMounts(model, project, spec);
      const duplicate = duplicateMountPoint(mounts);
      if (duplicate)
        return {
          code: 1,
          stderr: `${messages.map((line) => ` ${line}`).join("\n")}\nError response from daemon: Duplicate mount point: ${duplicate}\n`,
        };
      for (const old of existing) {
        if (ROLE_SERVICES.has(name)) await this.hooks.stopRole(name);
        this.containers.delete(old.Id);
        messages.push(`Container ${old.Name.slice(1)} Recreate`);
      }
      const container = this.newContainer({
        name: spec.container_name ?? `${project}-${name}-1`,
        imageId,
        imageReference: spec.image,
        service: name,
        labels: {
          ...(spec.labels ?? {}),
          "com.docker.compose.project": project,
          "com.docker.compose.service": name,
          "com.docker.compose.container-number": "1",
          "com.docker.compose.oneoff": "False",
          "com.docker.compose.project.working_dir": directory,
          "com.docker.compose.project.config_files": files.join(","),
          "com.docker.compose.config-hash": configHash,
          "com.docker.compose.image": imageId,
          "com.docker.compose.version": "2.40.3",
        },
        env: Object.entries(spec.environment ?? {}).map(([key, value]) =>
          value === null ? key : `${key}=${value}`,
        ),
        user: spec.user,
        groups: spec.group_add ?? null,
        mounts,
        memory: memoryBytes(spec.deploy?.resources?.limits?.memory ?? spec.mem_limit),
        nanoCpus: Math.round(Number(spec.deploy?.resources?.limits?.cpus ?? spec.cpus ?? 0) * 1e9),
      });
      if (!spec.healthcheck || spec.healthcheck.disable) delete container.State.Health;
      if (!noStart) {
        this.markRunning(container);
        this.unhealthyServices.delete(name);
        if (ROLE_SERVICES.has(name)) await this.hooks.startRole(name, container);
        messages.push(`Container ${container.Name.slice(1)} Started`);
      }
    }
    return { code: 0, stderr: `${messages.map((line) => ` ${line}`).join("\n")}\n` };
  }

  /** The mounts Docker reports for a Compose service: its volumes of every
   * type, and its secrets and configs as read-only file binds. A named
   * volume is backed by a directory under the engine's volume root. */
  private composeMounts(model: ComposeModel, project: string, spec: ComposeService) {
    const mounts: ContainerRecord["Mounts"] = [];
    for (const volume of spec.volumes ?? []) {
      const rw = !volume.read_only;
      if (volume.type === "volume") {
        const name = model.volumes?.[volume.source]?.name ?? `${project}_${volume.source}`;
        const source = join(this.volumeRoot, name);
        mkdirSync(source, { recursive: true, mode: 0o755 });
        mounts.push({
          Type: "volume",
          Name: name,
          Source: source,
          Destination: volume.target,
          RW: rw,
          Mode: rw ? "rw" : "ro",
        });
      } else
        mounts.push({
          Type: volume.type,
          Source: volume.source ?? "",
          Destination: volume.target,
          RW: rw,
          Mode: rw ? "rw" : "ro",
        });
    }
    for (const secret of spec.secrets ?? [])
      mounts.push({
        Type: "bind",
        Source: model.secrets?.[secret.source]?.file ?? "",
        Destination: `/run/secrets/${secret.target ?? secret.source}`,
        RW: false,
        Mode: "ro",
      });
    for (const config of spec.configs ?? []) {
      const target = config.target?.startsWith("/")
        ? config.target
        : `/${config.target ?? config.source}`;
      mounts.push({
        Type: "bind",
        Source: model.configs?.[config.source]?.file ?? "",
        Destination: target,
        RW: false,
        Mode: "ro",
      });
    }
    return mounts;
  }

  private async composePs(global: string[], args: string[], request: Request): Promise<Answer> {
    const { project } = await this.composeModel(global, request);
    const services = args.filter(
      (value) =>
        !value.startsWith("-") &&
        value !== flagValue(args, "--format") &&
        value !== flagValue(args, "--status") &&
        value !== flagValue(args, "--filter"),
    );
    const all = args.includes("-a") || args.includes("--all");
    const quiet = args.includes("-q") || args.includes("--quiet");
    const rows = this.composeContainers(project)
      .filter((c) => all || c.State.Running)
      .filter(
        (c) =>
          !services.length ||
          services.includes(c.Config.Labels["com.docker.compose.service"] as string),
      );
    if (quiet) return { code: 0, stdout: rows.map((c) => `${c.Id}\n`).join("") };
    const format = flagValue(args, "--format");
    const objects = rows.map((c) => ({
      ID: c.Id,
      Name: c.Name.slice(1),
      Names: c.Name.slice(1),
      Image: c.Config.Image,
      Service: c.Config.Labels["com.docker.compose.service"],
      Project: project,
      State: c.State.Status,
      Health: c.State.Health?.Status ?? "",
      Status: c.State.Running ? "Up 1 minute" : "Exited",
      ExitCode: c.State.ExitCode,
      Labels: Object.entries(c.Config.Labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(","),
    }));
    if (format === "json" || format === "{{json .}}")
      return { code: 0, stdout: objects.map((o) => `${JSON.stringify(o)}\n`).join("") };
    if (format)
      return { code: 0, stdout: objects.map((o) => `${renderGoTemplate(format, o)}\n`).join("") };
    return { code: 0, stdout: objects.map((o) => `${o.Name} ${o.State}\n`).join("") };
  }

  private servicesOf(args: string[], skipValue: string[]): string[] {
    const services: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (skipValue.includes(arg)) i++;
      else if (!arg.startsWith("-")) services.push(arg);
    }
    return services;
  }

  private async composeStop(global: string[], args: string[], request: Request): Promise<Answer> {
    const { project } = await this.composeModel(global, request);
    const services = this.servicesOf(args, ["-t", "--timeout", "-s", "--signal"]);
    for (const container of this.composeContainers(project)) {
      const service = container.Config.Labels["com.docker.compose.service"] as string;
      if (services.length && !services.includes(service)) continue;
      if (ROLE_SERVICES.has(service)) await this.hooks.stopRole(service);
      this.markExited(container, 0);
    }
    return { code: 0, stderr: "" };
  }

  private async composeStart(global: string[], args: string[], request: Request): Promise<Answer> {
    const { project } = await this.composeModel(global, request);
    const services = this.servicesOf(args, []);
    for (const container of this.composeContainers(project)) {
      const service = container.Config.Labels["com.docker.compose.service"] as string;
      if (services.length && !services.includes(service)) continue;
      this.markRunning(container);
      if (ROLE_SERVICES.has(service)) await this.hooks.startRole(service, container);
    }
    return { code: 0, stderr: "" };
  }

  private async composeRemove(global: string[], args: string[], request: Request): Promise<Answer> {
    const { project } = await this.composeModel(global, request);
    const services = this.servicesOf(args, ["-t", "--timeout", "--rmi"]);
    for (const container of this.composeContainers(project)) {
      const service = container.Config.Labels["com.docker.compose.service"] as string;
      if (services.length && !services.includes(service)) continue;
      if (ROLE_SERVICES.has(service)) await this.hooks.stopRole(service);
      this.containers.delete(container.Id);
    }
    return { code: 0, stderr: "" };
  }

  private async composePull(global: string[], args: string[], request: Request): Promise<Answer> {
    const { model } = await this.composeModel(global, request);
    const services = this.servicesOf(args, ["--policy"]);
    for (const [name, spec] of Object.entries(model.services)) {
      if (services.length && !services.includes(name)) continue;
      const answer = this.pull([spec.image]);
      if (answer.code !== 0) return answer;
    }
    return { code: 0, stderr: "" };
  }

  /** Every invocation of a caller that changes containers or images. */
  effects(caller?: string): Invocation[] {
    return this.trace.filter(
      (invocation) => (!caller || invocation.caller === caller) && isEffect(invocation.args),
    );
  }
}

interface ComposeModel {
  name?: string;
  services: Record<string, ComposeService>;
  volumes?: Record<string, { name?: string }>;
  secrets?: Record<string, { file?: string }>;
  configs?: Record<string, { file?: string }>;
}

interface ComposeService {
  image: string;
  secrets?: Array<{ source: string; target?: string }>;
  configs?: Array<{ source: string; target?: string }>;
  container_name?: string;
  environment?: Record<string, string | null>;
  labels?: Record<string, string>;
  user?: string;
  group_add?: string[];
  volumes?: Array<{ type: string; source: string; target: string; read_only?: boolean }>;
  healthcheck?: { disable?: boolean };
  deploy?: { resources?: { limits?: { memory?: string | number; cpus?: string | number } } };
  mem_limit?: string | number;
  cpus?: string | number;
}

function memoryBytes(value: string | number | undefined): number {
  if (value === undefined) return 0;
  if (typeof value === "number") return value;
  const match = /^([0-9.]+)\s*([kmgt]?)i?b?$/i.exec(value.trim());
  if (!match) return Number(value) || 0;
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[
    (match[2] ?? "").toLowerCase() as "" | "k" | "m" | "g" | "t"
  ];
  return Math.round(Number(match[1]) * scale);
}

function publicContainer(container: ContainerRecord) {
  const { service: _service, ...visible } = container;
  return visible;
}

export function isEffect(args: readonly string[]): boolean {
  const list = args.filter((value) => !value.startsWith("-"));
  const [command, sub] = list;
  if (command === "compose") {
    const action = args.find((value) =>
      [
        "up",
        "create",
        "stop",
        "kill",
        "start",
        "restart",
        "rm",
        "down",
        "pull",
        "run",
        "exec",
      ].includes(value),
    );
    return action !== undefined;
  }
  if (command === "container" || command === "image")
    return ["rm", "stop", "kill", "start", "run", "create", "pull", "restart"].includes(sub ?? "");
  return ["run", "create", "rm", "stop", "kill", "start", "restart", "pull", "exec"].includes(
    command ?? "",
  );
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === flag && args[i + 1] !== undefined) values.push(args[i + 1] as string);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

function flagValuesFrom(args: readonly string[], flags: string[]): string[] {
  return flags.flatMap((flag) => flagValues(args, flag));
}

/** Arguments that are not flags or the values of the named flags. */
function positional(args: readonly string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (valueFlags.includes(arg)) i++;
    else if (arg.startsWith("-")) continue;
    else out.push(arg);
  }
  return out;
}

export { digestOf };

/** The first container path mounted twice, which the daemon refuses with
 * "Duplicate mount point". Paths compare as Docker cleans them. */
function duplicateMountPoint(mounts: ContainerRecord["Mounts"]): string | undefined {
  const seen = new Set<string>();
  for (const mount of mounts) {
    const target = posix.normalize(mount.Destination).replace(/(.)\/+$/, "$1");
    if (seen.has(target)) return target;
    seen.add(target);
  }
  return undefined;
}
