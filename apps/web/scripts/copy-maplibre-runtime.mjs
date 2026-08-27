#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyMapLibreRuntimeAssets } from "./maplibre-runtime.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
copyMapLibreRuntimeAssets(resolve(webRoot, "public/runtime"));
