import { resolve } from "node:path";
import { packageIntegration } from "@openmapx/integration-framework/installer";

export interface PackageCommandOptions {
  source: string;
  out: string;
  build?: boolean;
}

export async function runPackage(opts: PackageCommandOptions): Promise<void> {
  const { source, out, build = true } = opts;

  const result = await packageIntegration({
    rootDir: process.cwd(),
    source: resolve(source),
    outFile: resolve(out),
    buildFrontend: build,
    buildBackend: build,
    onLog: (line, stream) => {
      if (stream === "stderr") {
        console.error(line);
      } else {
        console.log(line);
      }
    },
  });

  console.log(`Packaged integration: ${result.id}`);
  console.log(`Artifact: ${result.artifactPath}`);
}
