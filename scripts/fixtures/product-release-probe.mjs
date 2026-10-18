// Fixed subprocess entry point: test inputs are JSON data, never generated JavaScript.
import { readFileSync } from "node:fs";
import {
  inspectPublication,
  prepareProductRelease,
  publishProductRelease,
} from "../product-release.mjs";
import { assert } from "../product-release-config.mjs";
import { createReleasePorts } from "../product-release-io.mjs";

const request = JSON.parse(readFileSync(0, "utf8"));
assert(request && typeof request === "object" && !Array.isArray(request), "Invalid probe request");
const { operation, inputs } = request;
assert(inputs && typeof inputs === "object" && !Array.isArray(inputs), "Invalid probe inputs");
const ports = createReleasePorts();
let result;
switch (operation) {
  case "prepare":
    result = await prepareProductRelease(inputs, ports);
    break;
  case "inspect":
    result = await inspectPublication(inputs, ports);
    break;
  case "publish":
    result = await publishProductRelease(inputs, ports);
    break;
  case "verify-tag-target":
    assert(["check", "require", "create"].includes(inputs.mode), "Invalid tag operation");
    await ports.verifyTagTarget(inputs.version, inputs.revision, inputs.mode);
    result = true;
    break;
  default:
    throw new Error("Unknown probe operation");
}
console.log(JSON.stringify(result));
