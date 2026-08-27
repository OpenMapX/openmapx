import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { OPS_KIND_POLICIES, OPS_OPERATION_KINDS } from "../packages/core/src/ops/contract";

const root = join(__dirname, "..");
interface Inventory {
  schemaVersion: number;
  callSites: string[];
  typedEffectRoles: Record<"api" | "data-manager", string[]>;
  trustedDataSourceKinds: string[];
  sourceUnions: Record<string, string[]>;
  businessEffects: Array<{
    id: string;
    callSiteIds: string[];
    semanticSources: string[];
    typedKinds: string[];
  }>;
  mounts: string[];
  providers: string[];
}
const inventory = JSON.parse(
  readFileSync(join(root, "scripts", "ops-authority-inventory.json"), "utf8"),
) as Inventory;

function productionTypescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") files.push(...productionTypescriptFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

function discoverProcessCallSites(): string[] {
  const files = [join(root, "apps/api/src"), join(root, "services/data-manager/src")]
    .flatMap(productionTypescriptFiles)
    .sort();
  const discovered: string[] = [];
  for (const path of files) {
    const sourceText = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
    const ordinals = new Map<string, number>();
    const processCallees = new Set(["runner"]);
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        ["node:child_process", "child_process", "execa"].includes(statement.moduleSpecifier.text)
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) processCallees.add(binding.name.text);
        }
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.initializer &&
            ts.isCallExpression(declaration.initializer) &&
            declaration.initializer.expression.getText(source) === "promisify"
          ) {
            processCallees.add(declaration.name.text);
          }
        }
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source);
        const basename = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : callee;
        if (processCallees.has(basename)) {
          const ordinal = (ordinals.get(callee) ?? 0) + 1;
          ordinals.set(callee, ordinal);
          const argument = node.arguments[0];
          const target =
            argument &&
            (ts.isStringLiteralLike(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
              ? argument.text
              : (argument?.getText(source) ?? "missing");
          const relativePath = path.slice(root.length + 1);
          const prefix = `${relativePath}|${callee}|${ordinal}|${target}|`;
          const expected = inventory.callSites.find((entry) => entry.startsWith(prefix));
          discovered.push(expected ?? `${prefix}UNCLASSIFIED|UNCLASSIFIED`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return discovered.sort();
}

function discoverAuthorityMounts(): string[] {
  const discovered: string[] = [];
  for (const service of readdirSync(join(root, "services"))) {
    const manifestPath = join(root, "services", service, "service.json");
    if (!statExists(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bindMounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
    };
    for (const mount of manifest.bindMounts ?? []) {
      const authorityShape = `${mount.source}\n${mount.target}`;
      if (
        mount.source === "@docker-socket" ||
        authorityShape.includes("docker.sock") ||
        authorityShape.includes("OPENMAPX_HOST_DIR") ||
        authorityShape.includes("OPENMAPX_DOCKER_CONFIG_DIR") ||
        /(?:^|\/)\.docker(?:\/|$)/.test(authorityShape)
      ) {
        discovered.push(
          `${service}|${mount.source}|${mount.target}|${String(mount.readOnly ?? true)}`,
        );
      }
    }
  }
  return discovered.sort();
}

function statExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function discoverDockerProviders(): string[] {
  const discovered: string[] = [];
  const files = readdirRecursive(join(root, "services")).filter((path) =>
    /\.(?:ya?ml|json|toml)$/.test(path),
  );
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    const marker = "unix:///var/run/docker.sock";
    const count = source.split(marker).length - 1;
    if (count > 0) discovered.push(`${path.slice(root.length + 1)}|${marker}|${count}`);
  }
  return discovered.sort();
}

function readdirRecursive(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...readdirRecursive(path));
    else files.push(path);
  }
  return files;
}

function sourceSymbolExists(sourceId: string): boolean {
  const [relativePath, symbol] = sourceId.split("#");
  const path = join(root, relativePath);
  if (!statExists(path)) return false;
  if (!symbol) return true;
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements.some((statement) => {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name?.text === symbol
    ) {
      return true;
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === symbol,
      )
    );
  });
}

function readLiteralUnion(sourceId: string): string[] {
  const [relativePath, symbol] = sourceId.split("#");
  const path = join(root, relativePath);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const alias = source.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === symbol,
  );
  if (!alias) return [];
  const nodes = ts.isUnionTypeNode(alias.type) ? alias.type.types : [alias.type];
  return nodes.flatMap((node) =>
    ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [],
  );
}

describe("production authority inventory", () => {
  it("compares the exact bidirectional process-callsite/effect/owner set", () => {
    expect(inventory.schemaVersion).toBe(2);
    expect(discoverProcessCallSites()).toEqual([...inventory.callSites].sort());
    for (const entry of inventory.callSites) {
      const [, , , , owner, effectId] = entry.split("|");
      expect(["ops-agent", "data-manager-worker", "transitous-runner"]).toContain(owner);
      expect(effectId).toMatch(/^[a-z][A-Za-z0-9.-]+$/);
    }
  });

  it("maps the frozen typed-effect set exactly to its authenticated role and ops-agent owner", () => {
    const mapped = Object.values(inventory.typedEffectRoles).flat().sort();
    expect(mapped).toEqual([...OPS_OPERATION_KINDS].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
    for (const role of ["api", "data-manager"] as const) {
      for (const kind of inventory.typedEffectRoles[role]) {
        expect(OPS_KIND_POLICIES[kind as keyof typeof OPS_KIND_POLICIES].role).toBe(role);
      }
    }
    for (const kind of inventory.trustedDataSourceKinds) expect(mapped).toContain(kind);
  });

  it("links every business effect and source union bidirectionally to exact typed kinds", () => {
    const businessKinds = inventory.businessEffects.flatMap((effect) => effect.typedKinds).sort();
    expect(businessKinds).toEqual([...OPS_OPERATION_KINDS].sort());
    expect(new Set(businessKinds).size).toBe(businessKinds.length);
    for (const effect of inventory.businessEffects) {
      expect(effect.id).toMatch(/^[a-z][a-z0-9.-]+$/);
      for (const callSiteId of effect.callSiteIds) {
        expect(
          inventory.callSites.some((entry) => entry.startsWith(`${callSiteId}|`)),
          `${effect.id}: ${callSiteId}`,
        ).toBe(true);
      }
      for (const semanticSource of effect.semanticSources) {
        expect(sourceSymbolExists(semanticSource), `${effect.id}: ${semanticSource}`).toBe(true);
      }
    }
    for (const [sourceId, expected] of Object.entries(inventory.sourceUnions)) {
      expect(readLiteralUnion(sourceId).sort()).toEqual([...expected].sort());
    }
  });

  it("compares the exact normalized authority mount set across every production manifest", () => {
    expect(discoverAuthorityMounts()).toEqual([...inventory.mounts].sort());
  });

  it("compares the exact normalized Docker provider set across production service configuration", () => {
    expect(discoverDockerProviders()).toEqual([...inventory.providers].sort());
  });
});
