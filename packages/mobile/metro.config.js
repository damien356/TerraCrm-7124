const { getDefaultConfig } = require("expo/metro-config");
const { resolve } = require("path");

const config = getDefaultConfig(__dirname);

// ── Workspace module resolution ────────────────────────────────────────
// Metro's project root is packages/mobile/. In a Bun workspace, packages
// installed via `npx expo install` may end up in packages/mobile/node_modules
// while hoisted deps live at the workspace root node_modules/. Tell Metro
// to search both so every install path resolves correctly.
const workspaceRoot = resolve(__dirname, "../..");

config.watchFolders = [workspaceRoot];
config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [resolve(__dirname, "node_modules"), resolve(workspaceRoot, "node_modules")],
};

// ── expo-network stand-in (notes 18.57) ────────────────────────────────
// @better-auth/expo imports expo-network, which Terra does not ship. Left
// unresolved, that import closed the app straight after the logo. Point it
// at a small stand-in that keeps the library's "always online" fallback.
const networkShim = resolve(__dirname, "lib/expo-network-shim.ts");
const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "expo-network") return { type: "sourceFile", filePath: networkShim };
  return (upstreamResolve ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
