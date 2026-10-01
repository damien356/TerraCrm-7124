import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { Colors, Fonts } from "@/constants/theme";
import { client, crewClient, siteUrl } from "@/lib/api";
import {
  crewKeySupported,
  ensureCrewKey,
  forgetCrewKey,
  hasAutoArrive,
  hasSiri,
  keyUnused,
  setAutoArriveFlag,
  setSiriFlag,
} from "@/lib/crew-key";
import { fencesSupported, stopSiteFences, syncSiteFences, type FenceState } from "@/lib/site-fences";
import { useSetNavApp, useVoiceSettings } from "@/queries/crew";

const c = Colors.light;

/** What to say. Every phrase has "Terra" in it so Siri knows which app. */
export const SIRI_PHRASES = [
  "What's my next job in Terra",
  "Direct me to my next job in Terra",
  "What's on the job sheet in Terra",
  "Tell my next job I'm running late in Terra",
  "Tell the office I'm running late in Terra",
  "Call the site contact in Terra",
  "Call the office in Terra",
  "Add a note to this job in Terra",
];

const NAV_APPS = [
  { id: "apple", label: "Apple Maps" },
  { id: "google", label: "Google Maps" },
  { id: "waze", label: "Waze" },
] as const;

function Switch({ on, busy, onPress, label }: { on: boolean; busy: boolean; onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on, busy }}
      onPress={() => (busy ? undefined : onPress())}
      style={{
        backgroundColor: on ? c.secondary : c.primary,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 9,
        minWidth: 88,
        alignItems: "center",
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={on ? c.foreground : "#FFFFFF"} />
      ) : (
        <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: on ? c.foreground : "#FFFFFF" }}>
          {on ? "Switch off" : "Switch on"}
        </Text>
      )}
    </Pressable>
  );
}

function fenceLine(state: FenceState | null, count: number) {
  switch (state) {
    case "watching":
      return `Watching ${count} site${count === 1 ? "" : "s"} for today and tomorrow.`;
    case "nothing_booked":
      return "Nothing booked today or tomorrow, so nothing to watch yet.";
    case "needs_always":
      return "Location is not set to Always, so tap Arrived and Left site on the job instead.";
    case "error":
      return "Couldn't load your sites just now. It tries again next time you open Terra.";
    default:
      return null;
  }
}

/**
 * HANDS-FREE on the Me tab: Siri and CarPlay, which maps app opens for
 * directions, and arriving and leaving site by location. All three are the
 * installer's own switches. iPhone only for now.
 */
export function HandsFreeCard() {
  const router = useRouter();
  const settings = useVoiceSettings();
  const setNav = useSetNavApp();
  const [siriOn, setSiriOn] = useState(false);
  const [autoOn, setAutoOn] = useState(false);
  const [fence, setFence] = useState<{ state: FenceState; count: number } | null>(null);
  const [busy, setBusy] = useState<null | "siri" | "auto">(null);
  const [error, setError] = useState<string | null>(null);
  const [showPhrases, setShowPhrases] = useState(false);

  const refresh = useCallback(async () => {
    if (!crewKeySupported) return;
    setSiriOn(await hasSiri());
    const auto = await hasAutoArrive();
    setAutoOn(auto);
    setFence(auto ? await syncSiteFences() : null);
  }, []);

  // Coming back from the consent screen or from iPhone Settings.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Revoke and forget the key once neither Siri nor auto arrival needs it. */
  async function releaseKeyIfUnused() {
    if (!(await keyUnused())) return;
    try {
      await crewClient.voice.revokeKey({});
    } catch {
      /* Offline: the office can still turn it off from the Logins page. */
    }
    await forgetCrewKey();
  }

  async function toggleSiri() {
    setError(null);
    setBusy("siri");
    try {
      if (siriOn) {
        await setSiriFlag(false);
        await releaseKeyIfUnused();
      } else {
        await ensureCrewKey(siteUrl, (deviceName) => client.voice.issueKey({ deviceName }));
        await setSiriFlag(true);
        setShowPhrases(true);
      }
      await refresh();
      void settings.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that. Try again with signal.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleAuto() {
    setError(null);
    if (!autoOn) {
      router.push("/site-arrival");
      return;
    }
    setBusy("auto");
    try {
      await setAutoArriveFlag(false);
      await stopSiteFences();
      await releaseKeyIfUnused();
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const navApp = setNav.isPending ? setNav.variables?.app : settings.data?.navApp;
  const fenceText = autoOn ? fenceLine(fence?.state ?? null, fence?.count ?? 0) : null;

  return (
    <View
      style={{
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: siriOn || autoOn ? c.primary : c.border,
        borderRadius: 14,
        padding: 14,
        marginTop: 12,
      }}
    >
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
        HANDS-FREE
      </Text>

      {!crewKeySupported || !fencesSupported ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13, lineHeight: 18, color: c.mutedForeground, marginTop: 8 }}>
          Siri, CarPlay and arriving by location are on iPhone only for now. Android is coming later.
        </Text>
      ) : (
        <>
          {/* Siri and CarPlay */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 }}>
            <Ionicons name={siriOn ? "mic-circle" : "mic-circle-outline"} size={22} color={siriOn ? c.primary : c.mutedForeground} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>Siri and CarPlay</Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
                {siriOn ? "On for this phone" : "Off"}
              </Text>
            </View>
            <Switch on={siriOn} busy={busy === "siri"} onPress={() => void toggleSiri()} label="Siri and CarPlay" />
          </View>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, lineHeight: 18, color: c.mutedForeground, marginTop: 8 }}>
            Ask Siri about your next job with the phone in your pocket or on CarPlay. Anything that sends a text, makes a
            call or saves a note is read back to you first, and nothing happens until you say yes.
          </Text>
          <Pressable onPress={() => setShowPhrases((v) => !v)} style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.primary }}>
              {showPhrases ? "Hide what to say" : "What to say"}
            </Text>
            <Ionicons name={showPhrases ? "chevron-up" : "chevron-down"} size={14} color={c.primary} />
          </Pressable>
          {showPhrases ? (
            <View style={{ marginTop: 6, gap: 4 }}>
              {SIRI_PHRASES.map((p) => (
                <Text key={p} style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.foreground }}>
                  "Hey Siri, {p.charAt(0).toLowerCase() + p.slice(1)}"
                </Text>
              ))}
            </View>
          ) : null}

          {/* Maps app */}
          <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 14, paddingTop: 12 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.foreground }}>Directions open in</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {NAV_APPS.map((a) => {
                const picked = (navApp ?? "apple") === a.id;
                return (
                  <Pressable
                    key={a.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: picked }}
                    onPress={() => {
                      if (!picked) setNav.mutate({ app: a.id });
                    }}
                    style={{
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 9,
                      borderWidth: 1,
                      borderColor: picked ? c.primary : c.border,
                      backgroundColor: picked ? "#F6E7DF" : c.card,
                    }}
                  >
                    <Text style={{ fontFamily: picked ? Fonts.bold : Fonts.medium, fontSize: 13, color: picked ? c.primary : c.foreground }}>
                      {a.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Arriving by location */}
          <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 14, paddingTop: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Ionicons name={autoOn ? "location" : "location-outline"} size={20} color={autoOn ? c.primary : c.mutedForeground} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>Arrive and leave by location</Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
                  {autoOn ? "On" : "Off, you tap Arrived and Left site"}
                </Text>
              </View>
              <Switch on={autoOn} busy={busy === "auto"} onPress={() => void toggleAuto()} label="Arrive and leave by location" />
            </View>
            {fenceText ? (
              <Text
                style={{
                  fontFamily: Fonts.sans,
                  fontSize: 12.5,
                  lineHeight: 18,
                  color: fence?.state === "needs_always" ? c.warning : c.mutedForeground,
                  marginTop: 8,
                }}
              >
                {fenceText}
              </Text>
            ) : null}
            {autoOn && fence?.state === "needs_always" ? (
              <Pressable onPress={() => void Linking.openSettings()} style={{ marginTop: 6 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.primary }}>Open iPhone Settings</Text>
              </Pressable>
            ) : null}
          </View>
        </>
      )}

      {error ? (
        <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.destructive, marginTop: 10 }}>{error}</Text>
      ) : null}
    </View>
  );
}
