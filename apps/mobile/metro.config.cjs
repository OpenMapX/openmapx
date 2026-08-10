const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Workspace sources (`packages/core`, `packages/i18n`, ...) are consumed as
// TypeScript, so Metro has to watch the repository root.
config.watchFolders = [workspaceRoot];

// pnpm's isolated layout puts each package's dependencies in its own
// `node_modules`, so hierarchical lookup stays on and Expo's defaults are
// extended rather than replaced. Symlink resolution is already on by default.
config.resolver.nodeModulesPaths = [
  ...new Set([
    ...(config.resolver.nodeModulesPaths ?? []),
    path.resolve(projectRoot, "node_modules"),
  ]),
];

// One React and one React Native runtime, always the copies installed in
// `apps/mobile`. The whole workspace currently resolves the same React, so this
// is drift protection: if the web stack ever moves ahead of React Native's peer
// range, a stray import would otherwise bundle a second renderer, which fails
// as a null hook dispatcher rather than as a resolution error.
const PINNED_RUNTIME_PACKAGES = new Set(["react", "react-native"]);
const pinnedRoot = (name) =>
  path.dirname(require.resolve(`${name}/package.json`, { paths: [projectRoot] }));

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const scope = moduleName.startsWith("@") ? null : moduleName.split("/")[0];
  if (scope && PINNED_RUNTIME_PACKAGES.has(scope)) {
    const subpath = moduleName.slice(scope.length);
    return context.resolveRequest(
      context,
      subpath ? path.join(pinnedRoot(scope), subpath) : pinnedRoot(scope),
      platform,
    );
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
