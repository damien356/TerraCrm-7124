import { useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomInset } from "@/hooks/use-bottom-gap";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { Colors, Fonts } from "@/constants/theme";
import { client, siteUrl } from "@/lib/api";
import { ensureCrewKey, setAutoArriveFlag } from "@/lib/crew-key";
import { fencesSupported, syncSiteFences } from "@/lib/site-fences";

const c = Colors.light;

/** Each point the installer reads before iOS asks. Plain, short, true. */
const POINTS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: "location-outline",
    title: "Arrived and Left site, done for you",
    body: "Your phone watches a circle round each site you're booked at today or tomorrow. Walk in and you're marked Arrived. Drive off and you're marked Left site.",
  },
  {
    icon: "play-circle-outline",
    title: "It never starts the job",
    body: "Arriving only stamps the time. The damage walk and the Start tap are still yours.",
  },
  {
    icon: "car-outline",
    title: "Driving past doesn't count",
    body: "You have to be inside the circle for more than 5 minutes, and only on a day you're booked there.",
  },
  {
    icon: "camera-outline",
    title: "Completion photos every day",
    body: "Leave without that day's completion photos and the job goes red for the office, and you get a reminder. It clears once the photos are in, or when you go back to site that day.",
  },
  {
    icon: "eye-off-outline",
    title: "No tracking",
    body: "This is not the live map. The phone only tells Terra when you cross in or out of a site circle. Your route, your stops and your days off are never sent.",
  },
];

type Outcome =
  | { kind: "on"; line: string }
  | { kind: "not_always" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

/**
 * The yes or no for arriving and leaving by location. iOS needs "Always" for
 * this, which it asks for in two steps: "While using" first, then a second
 * prompt to change it to Always. Saying no to either is fine, the installer
 * taps Arrived and Left site on the job instead.
 */
export default function SiteArrivalScreen() {
  const bottomInset = useBottomInset();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function turnOn() {
    setBusy(true);
    setOutcome(null);
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) {
        setOutcome({ kind: "denied" });
        return;
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (!bg.granted) {
        setOutcome({ kind: "not_always" });
        return;
      }
      await ensureCrewKey(siteUrl, (deviceName) => client.voice.issueKey({ deviceName }));
      await setAutoArriveFlag(true);
      const r = await syncSiteFences();
      const line =
        r.state === "watching"
          ? `Watching ${r.count} site${r.count === 1 ? "" : "s"} for today and tomorrow.`
          : r.state === "nothing_booked"
            ? "Nothing booked today or tomorrow yet. It picks up new jobs each time you open Terra."
            : "It's on. Your sites load next time you open Terra with signal.";
      setOutcome({ kind: "on", line });
    } catch (e) {
      await setAutoArriveFlag(false).catch(() => undefined);
      setOutcome({ kind: "error", message: e instanceof Error ? e.message : "Couldn't switch it on. Try again with signal." });
    } finally {
      setBusy(false);
    }
  }

  const done = outcome?.kind === "on";

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
        <Pressable onPress={() => router.back()} style={{ padding: 4 }} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={c.foreground} />
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>Arrive and leave by location</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 48 + bottomInset }}>
        {!fencesSupported ? (
          <Text style={{ fontFamily: Fonts.sans, fontSize: 14, lineHeight: 20, color: c.mutedForeground }}>
            This is on iPhone only for now. Tap Arrived and Left site on the job instead.
          </Text>
        ) : (
          <>
            <View style={{ gap: 14 }}>
              {POINTS.map((p) => (
                <View key={p.title} style={{ flexDirection: "row", gap: 12 }}>
                  <Ionicons name={p.icon} size={22} color={c.primary} style={{ marginTop: 1 }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>{p.title}</Text>
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, lineHeight: 19, color: c.mutedForeground, marginTop: 2 }}>
                      {p.body}
                    </Text>
                  </View>
                </View>
              ))}
            </View>

            <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14, marginTop: 20 }}>
              <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>What your iPhone will ask</Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
                First "Allow While Using App". Then a second box asking to "Change to Always Allow". Pick Always, or the
                phone can't see you arrive while Terra is closed.
              </Text>
            </View>

            {outcome?.kind === "on" ? (
              <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", marginTop: 18 }}>
                <Ionicons name="checkmark-circle" size={20} color={c.success} />
                <Text style={{ flex: 1, fontFamily: Fonts.medium, fontSize: 14, lineHeight: 20, color: c.foreground }}>
                  On. {outcome.line}
                </Text>
              </View>
            ) : null}
            {outcome?.kind === "not_always" || outcome?.kind === "denied" ? (
              <View style={{ marginTop: 18 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 14, lineHeight: 20, color: c.warning }}>
                  {outcome.kind === "denied"
                    ? "Location is off for Terra, so this stays off. That's fine, tap Arrived and Left site on the job."
                    : "Location isn't set to Always, so this stays off. That's fine, tap Arrived and Left site on the job."}
                </Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 13, lineHeight: 19, color: c.mutedForeground, marginTop: 6 }}>
                  Changed your mind? iPhone Settings, Terra, Location, Always. Then switch this on again.
                </Text>
                <Pressable onPress={() => void Linking.openSettings()} style={{ marginTop: 8 }}>
                  <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.primary }}>Open iPhone Settings</Text>
                </Pressable>
              </View>
            ) : null}
            {outcome?.kind === "error" ? (
              <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.destructive, marginTop: 18 }}>{outcome.message}</Text>
            ) : null}

            <Pressable
              onPress={() => (done ? router.back() : busy ? undefined : void turnOn())}
              accessibilityRole="button"
              style={{
                backgroundColor: c.primary,
                borderRadius: 12,
                paddingVertical: 15,
                alignItems: "center",
                marginTop: 22,
                opacity: busy ? 0.7 : 1,
              }}
            >
              {busy ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: "#FFFFFF" }}>
                  {done ? "Done" : outcome && outcome.kind !== "error" ? "Try again" : "Turn it on"}
                </Text>
              )}
            </Pressable>
            {!done ? (
              <Pressable onPress={() => router.back()} accessibilityRole="button" style={{ paddingVertical: 14, alignItems: "center", marginTop: 4 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>No thanks, I'll tap by hand</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
