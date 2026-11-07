import { config } from "zod/v4/core";

// Run before application schemas are constructed. Even a caught eval probe
// reports a violation under our production CSP.
config({ jitless: true });
