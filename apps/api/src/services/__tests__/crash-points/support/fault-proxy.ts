/** An HTTP forwarder between two roles. It records every request and can
 * - let a matching request reach the upstream and then drop its reply, which
 *   is a lost response as the caller experiences it: the effect happened, the
 *   answer never arrived;
 * - hold a matching request until the test forwards it or discards it, which
 *   gives a deterministic moment between "sent" and "received". */
import {
  createServer,
  request as forward,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface ProxiedRequest {
  method: string;
  path: string;
  /** `operation.kind` for agent operations, when the body names one. */
  kind?: string;
  operationKey?: string;
  status?: number;
  /** From an agent answer: the operation it admitted or reported, and its state. */
  operationId?: string;
  state?: string;
  dropped: boolean;
}

export interface ReplyMatch {
  method?: string;
  path: RegExp;
  kind?: string;
  skip?: number;
  times?: number;
}

interface Rule {
  method?: string;
  path: RegExp;
  kind?: string;
  skip: number;
  times: number;
}

interface DropRule extends Rule {
  dropped: PromiseWithResolvers<ProxiedRequest>;
}

interface HoldRule extends Rule {
  entered: PromiseWithResolvers<ProxiedRequest>;
  decision: PromiseWithResolvers<"forward" | "discard">;
}

/** A request the proxy keeps from its upstream until the test decides. */
export interface HeldRequest {
  readonly entered: Promise<ProxiedRequest>;
  /** Sends the request on, as if it had only been slow. */
  forward(): void;
  /** Never sends it: the caller's connection closes without an answer. */
  discard(): void;
}

function take<T extends Rule>(rules: T[], entry: ProxiedRequest): T | undefined {
  const rule = rules.find(
    (candidate) =>
      candidate.times > 0 &&
      (!candidate.method || candidate.method === entry.method) &&
      candidate.path.test(entry.path) &&
      (!candidate.kind || candidate.kind === entry.kind),
  );
  if (!rule) return undefined;
  if (rule.skip > 0) {
    rule.skip--;
    return undefined;
  }
  rule.times--;
  return rule;
}

export class FaultProxy {
  readonly requests: ProxiedRequest[] = [];
  private readonly drops: DropRule[] = [];
  private readonly holds: HoldRule[] = [];
  private server?: Server;
  url = "";

  constructor(private upstream: string) {}

  async listen(): Promise<string> {
    this.server = createServer((incoming, outgoing) => this.receive(incoming, outgoing));
    this.server.requestTimeout = 0;
    this.server.headersTimeout = 0;
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  private receive(incoming: IncomingMessage, outgoing: ServerResponse) {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const entry: ProxiedRequest = {
        method: incoming.method ?? "GET",
        path: incoming.url ?? "/",
        dropped: false,
      };
      try {
        const parsed = JSON.parse(body.toString("utf8")) as {
          operation?: { kind?: string };
          operationKey?: string;
        };
        if (typeof parsed.operation?.kind === "string") entry.kind = parsed.operation.kind;
        if (typeof parsed.operationKey === "string") entry.operationKey = parsed.operationKey;
      } catch {
        // Not JSON; only the method and path are recorded.
      }
      this.requests.push(entry);
      // Only origin-form targets reach the one configured upstream; an
      // absolute-form or protocol-relative target could name another host.
      if (!entry.path.startsWith("/") || entry.path.startsWith("//")) {
        entry.status = 400;
        outgoing.writeHead(400).end();
        return;
      }
      const hold = take(this.holds, entry);
      if (!hold) {
        this.send(incoming, outgoing, entry, body);
        return;
      }
      hold.entered.resolve(entry);
      void hold.decision.promise.then((decision) => {
        if (decision === "forward") this.send(incoming, outgoing, entry, body);
        else {
          entry.dropped = true;
          outgoing.socket?.destroy();
        }
      });
    });
  }

  private send(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    entry: ProxiedRequest,
    body: Buffer,
  ) {
    const drop = take(this.drops, entry);
    const origin = new URL(this.upstream);
    const upstream = forward(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        path: entry.path,
        method: entry.method,
        headers: { ...incoming.headers, host: origin.host },
      },
      (response) => {
        const reply: Buffer[] = [];
        response.on("data", (chunk: Buffer) => reply.push(chunk));
        response.on("end", () => {
          entry.status = response.statusCode;
          try {
            const answer = JSON.parse(Buffer.concat(reply).toString("utf8")) as {
              result?: { operationId?: string; state?: string; operationKey?: string };
            };
            if (typeof answer.result?.operationId === "string")
              entry.operationId = answer.result.operationId;
            if (typeof answer.result?.state === "string") entry.state = answer.result.state;
            if (!entry.operationKey && typeof answer.result?.operationKey === "string")
              entry.operationKey = answer.result.operationKey;
          } catch {
            // Not a JSON answer.
          }
          if (drop) {
            entry.dropped = true;
            drop.dropped.resolve(entry);
            outgoing.socket?.destroy();
            return;
          }
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          outgoing.end(Buffer.concat(reply));
        });
      },
    );
    upstream.on("error", () => {
      entry.status = 502;
      outgoing.socket?.destroy();
    });
    upstream.end(body);
  }

  dropReply(match: ReplyMatch): Promise<ProxiedRequest> {
    const rule: DropRule = {
      method: match.method,
      path: match.path,
      kind: match.kind,
      skip: match.skip ?? 0,
      times: match.times ?? 1,
      dropped: Promise.withResolvers(),
    };
    this.drops.push(rule);
    return rule.dropped.promise;
  }

  holdRequest(match: ReplyMatch): HeldRequest {
    const rule: HoldRule = {
      method: match.method,
      path: match.path,
      kind: match.kind,
      skip: match.skip ?? 0,
      times: 1,
      entered: Promise.withResolvers(),
      decision: Promise.withResolvers(),
    };
    this.holds.push(rule);
    return {
      entered: rule.entered.promise,
      forward: () => rule.decision.resolve("forward"),
      discard: () => rule.decision.resolve("discard"),
    };
  }

  async close(): Promise<void> {
    for (const rule of this.holds) rule.decision.resolve("discard");
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
