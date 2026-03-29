const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const { FileStore } = require("metro-cache");
const path = require("node:path");

const config = getDefaultConfig(__dirname);

config.cacheStores = [
  new FileStore({ root: path.join(__dirname, "node_modules", ".cache", "metro") }),
];

module.exports = withNativeWind(config, { input: "./global.css" });
