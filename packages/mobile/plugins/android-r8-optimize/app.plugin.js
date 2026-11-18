/**
 * Android release builds use Google's optimising R8 rules.
 *
 * Damien, 18 Nov 2026: Google Play flagged build 15 for low DEX code
 * optimisation. expo-build-properties turns R8 on (minify and resource
 * shrinking), but the Expo template still points the release build at
 * proguard-android.txt. In Android Gradle Plugin 8.x that default file
 * contains -dontoptimize, so R8 would shrink and rename but skip the
 * optimisation step Google measures. This swaps it for
 * proguard-android-optimize.txt, the optimising default Google recommends.
 *
 * Android only. iOS is untouched. EAS runs prebuild in the cloud, there is
 * no android/ folder in git, so this has to live in a config plugin.
 *
 * Native change. Anything here means a new EAS build (UPDATES.md category 3).
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const FROM = 'getDefaultProguardFile("proguard-android.txt")';
const TO = 'getDefaultProguardFile("proguard-android-optimize.txt")';

module.exports = function withAndroidR8Optimize(config) {
  return withAppBuildGradle(config, (cfg) => {
    const gradle = cfg.modResults;
    if (gradle.language !== "groovy") {
      throw new Error("android-r8-optimize: expected a Groovy app/build.gradle");
    }
    if (gradle.contents.includes(TO)) return cfg;
    if (!gradle.contents.includes(FROM)) {
      // Fail the build rather than quietly ship an unoptimised bundle.
      throw new Error(
        "android-r8-optimize: could not find the default ProGuard file line in app/build.gradle. " +
          "The Expo template has changed; update this plugin.",
      );
    }
    gradle.contents = gradle.contents.split(FROM).join(TO);
    return cfg;
  });
};
