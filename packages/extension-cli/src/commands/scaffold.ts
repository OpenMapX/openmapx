import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve the templates directory relative to the current file.
 * When bundled by tsup into dist/cli.js, we are one level below the package
 * root so we step up once. When running from source (src/commands/scaffold.ts)
 * we step up twice to reach the package root.
 */
function findTemplatesDir(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Try the dist layout (one level up from the file)
  const fromDist = resolve(currentDir, "..", "templates");
  if (existsSync(fromDist)) return fromDist;
  // Fall back to the source layout (two levels up from src/commands/)
  const fromSrc = resolve(currentDir, "..", "..", "templates");
  return fromSrc;
}

const TEMPLATES_DIR = findTemplatesDir();
const INTEGRATION_TEMPLATE_DIR = join(TEMPLATES_DIR, "integration");
const SERVICE_TEMPLATE_DIR = join(TEMPLATES_DIR, "service");

function substituteTokensInDir(dir: string, id: string, domain: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      substituteTokensInDir(fullPath, id, domain);
    } else if (entry.isFile()) {
      const content = readFileSync(fullPath, "utf-8");
      const replaced = content.replaceAll("__ID__", id).replaceAll("__DOMAIN__", domain);
      if (replaced !== content) {
        writeFileSync(fullPath, replaced, "utf-8");
      }
    }
  }
}

export function scaffoldIntegration(opts: { id: string; domain?: string; outDir: string }): string {
  const { id, domain, outDir } = opts;

  if (!VALID_ID.test(id)) {
    throw new Error(
      `Invalid integration id "${id}". Must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`,
    );
  }

  const destDir = join(outDir, id);
  if (existsSync(destDir)) {
    throw new Error(
      `Directory "${destDir}" already exists. Choose a different id or remove the existing directory.`,
    );
  }

  if (!existsSync(INTEGRATION_TEMPLATE_DIR)) {
    throw new Error(`Template directory not found at ${INTEGRATION_TEMPLATE_DIR}.`);
  }

  const domainToken = domain ?? "__DOMAIN__";

  mkdirSync(destDir, { recursive: true });
  cpSync(INTEGRATION_TEMPLATE_DIR, destDir, { recursive: true });

  substituteTokensInDir(destDir, id, domainToken);

  const pkgTemplate = join(destDir, "package.json.template");
  if (existsSync(pkgTemplate)) {
    renameSync(pkgTemplate, join(destDir, "package.json"));
  }

  return destDir;
}

export function scaffoldService(opts: { id: string; outDir: string }): string {
  const { id, outDir } = opts;

  if (!VALID_ID.test(id)) {
    throw new Error(
      `Invalid service id "${id}". Must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.`,
    );
  }

  const serviceTemplatePath = join(SERVICE_TEMPLATE_DIR, "service.json");
  if (!existsSync(serviceTemplatePath)) {
    throw new Error(`Service template not found at ${serviceTemplatePath}.`);
  }

  mkdirSync(outDir, { recursive: true });

  const destPath = join(outDir, "service.json");
  if (existsSync(destPath)) {
    throw new Error(
      `"${destPath}" already exists. Remove it first or choose a different output directory.`,
    );
  }

  const content = readFileSync(serviceTemplatePath, "utf-8");
  const replaced = content.replaceAll("__ID__", id);
  writeFileSync(destPath, replaced, "utf-8");

  return destPath;
}
