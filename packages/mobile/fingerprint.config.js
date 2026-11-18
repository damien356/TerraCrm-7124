// Damien, 18 Nov 2026: keeps the phone app's runtime version steady when the
// only change is turning on Android release shrinking (R8) for Google Play's
// DEX optimisation check.
//
// Why: the runtime version decides which over the air updates a phone build
// accepts. Adding the expo-build-properties entry below to app.json would
// otherwise give iPhone build 18 (already with Apple) a different runtime
// from the code on main, so OTA updates sent from main would quietly stop
// reaching it. Shrinking and renaming Android's Java code does not change
// what the JavaScript can call, so OTA compatibility is unaffected.
//
// The same goes for ./plugins/android-r8-optimize, which only swaps the
// Android release build to Google's optimising R8 rules file.
//
// This only removes those exact entries from the fingerprint. If anyone adds
// or changes any other option on expo-build-properties, the entry no longer
// matches, stays in, and the runtime version changes as it should. The
// android-r8-optimize plugin file itself is also left out (ignorePaths), so
// if it is ever changed to do more than swap the rules file, take it out of
// ignorePaths and IGNORED_PLUGIN_PATHS below so the runtime version moves.

/** @typedef {import('@expo/fingerprint').Config} Config */

const IGNORED_ENTRY = JSON.stringify([
  "expo-build-properties",
  {
    android: {
      enableMinifyInReleaseBuilds: true,
      enableShrinkResourcesInReleaseBuilds: true,
    },
  },
]);

// Same ordering rules as @expo/fingerprint's stringifyJsonSorted, so an
// unchanged config gives exactly the same text back.
function sortJson(json) {
  if (Array.isArray(json)) {
    return json.sort((a, b) => {
      const sa = stringifyJsonSorted(a);
      const sb = stringifyJsonSorted(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  if (json != null && typeof json === "object") {
    return Object.keys(json)
      .sort()
      .reduce((acc, key) => {
        acc[key] = json[key];
        return acc;
      }, {});
  }
  return json;
}

function stringifyJsonSorted(target) {
  return JSON.stringify(target, (_, value) => sortJson(value));
}

function sortedEntry(entry) {
  return stringifyJsonSorted(JSON.parse(JSON.stringify(entry)));
}

const IGNORED_SORTED = sortedEntry(JSON.parse(IGNORED_ENTRY));

const IGNORED_PLUGIN_PATHS = ["./plugins/android-r8-optimize/app.plugin.js"];

function isIgnoredPlugin(p) {
  if (typeof p === "string") return IGNORED_PLUGIN_PATHS.includes(p);
  return Array.isArray(p) && sortedEntry(p) === IGNORED_SORTED;
}

/** @type {Config} */
const config = {
  ignorePaths: ["plugins/android-r8-optimize/app.plugin.js"],
  fileHookTransform: (source, chunk) => {
    if (source.type !== "contents" || source.id !== "expoConfig") return chunk;
    if (typeof chunk !== "string") return chunk;
    let parsed;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      return chunk;
    }
    // Only act if re-encoding gives back exactly what fingerprint produced.
    if (stringifyJsonSorted(JSON.parse(chunk)) !== chunk) return chunk;
    if (!Array.isArray(parsed.plugins)) return chunk;
    const kept = parsed.plugins.filter((p) => !isIgnoredPlugin(p));
    if (kept.length === parsed.plugins.length) return chunk;
    parsed.plugins = kept;
    return stringifyJsonSorted(parsed);
  },
};

module.exports = config;
