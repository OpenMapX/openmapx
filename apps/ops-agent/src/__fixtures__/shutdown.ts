import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOpsAgentServer } from "../bootstrap";
import { createRegistryResourcePolicy, denyAllTrustedOpsData } from "../policy";

let release!: () => void;
const held = new Promise<void>((resolve) => { release = resolve; });
process.on("message", (message) => { if (message === "release") release(); });
const app = await startOpsAgentServer({
  tokens: { api: "shutdown-fixture-token", "data-manager": "shutdown-dm-token" },
  resourcePolicy: createRegistryResourcePolicy({ serviceIds: [], integrationIds: [], trustedData: denyAllTrustedOpsData }),
  dispatch: async () => {
    process.send?.({ event: "working" });
    await held;
    writeFileSync(join(process.argv[2]!, "completed"), "drained");
    return { reachable: true };
  },
}, { initialize: async () => {} }, { host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw Error("Listener missing");
process.send?.({ event: "ready", port: address.port });
