/**
 * Terra Siri commands. Copies TerraIntents.swift into the iOS app target at
 * prebuild (EAS runs prebuild in the cloud, there is no ios/ folder in git).
 *
 * App Intents and App Shortcuts need no entitlement, no Siri capability and
 * no extension target: they run inside the app itself, which is what lets them
 * read the crew key from the app's own keychain. iOS 16 or later.
 *
 * Native change. Anything here means a new EAS build (UPDATES.md category 3).
 */
const fs = require("fs");
const path = require("path");
const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const FILE = "TerraIntents.swift";

/** Write the Swift source next to AppDelegate.swift. */
const withIntentsSource = (config) =>
  withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const target = path.join(cfg.modRequest.platformProjectRoot, projectName, FILE);
      fs.copyFileSync(path.join(__dirname, FILE), target);
      return cfg;
    },
  ]);

/** Add it to the app target's Compile Sources, once. */
const withIntentsInProject = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    const filepath = `${projectName}/${FILE}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: projectName, project });
    }
    return cfg;
  });

module.exports = function withTerraSiri(config) {
  config = withIntentsSource(config);
  config = withIntentsInProject(config);
  return config;
};
