import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from "expo-audio";
import { Colors, Fonts } from "@/constants/theme";
import { siteUrl } from "@/lib/api";
import { uploadVoiceRecording, useProcessVoiceQuote } from "@/queries/voiceQuotes";

const c = Colors.light;

// Speech only, so one channel at 64 kbps. About half a megabyte a minute,
// which still goes up on one bar of signal and is plenty for transcription.
const SPEECH: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64000,
  web: { mimeType: "audio/webm", bitsPerSecond: 64000 },
};

// Whisper stops at 25 MB. Ten minutes is far under that and far longer than
// anyone talks through one job.
const MAX_SECONDS = 600;

type Stage = "idle" | "recording" | "recorded" | "uploading" | "processing" | "done";

type Result = {
  quote: { id: number; number: number; status: string };
  transcript: string;
  flaggedCount: number;
  lineCount: number;
  matchedCustomerName: string | null;
};

function clock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Soft ring that breathes behind the button while it records. */
function Pulse({ active }: { active: boolean }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      v.stopAnimation();
      v.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, v]);

  if (!active) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        width: 150,
        height: 150,
        borderRadius: 75,
        backgroundColor: c.destructive,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0] }),
        transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }],
      }}
    />
  );
}

function BigButton({
  label,
  icon,
  onPress,
  tone = "primary",
  disabled,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  tone?: "primary" | "plain";
  disabled?: boolean;
}) {
  const primary = tone === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        height: 54,
        borderRadius: 14,
        backgroundColor: primary ? c.primary : c.card,
        borderWidth: primary ? 0 : 1,
        borderColor: c.border,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      {icon ? <Ionicons name={icon} size={19} color={primary ? "#FFFFFF" : c.foreground} /> : null}
      <Text style={{ fontFamily: Fonts.bold, fontSize: 15.5, color: primary ? "#FFFFFF" : c.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  const color = tone === "warn" ? c.warning : tone === "good" ? c.success : c.foreground;
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        padding: 12,
      }}
    >
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}>
        {label}
      </Text>
      <Text style={{ fontFamily: Fonts.bold, fontSize: 17, color, marginTop: 3 }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function VoiceQuoteScreen() {
  const router = useRouter();
  const recorder = useAudioRecorder(SPEECH);
  const recState = useAudioRecorderState(recorder, 250);
  const [stage, setStage] = useState<Stage>("idle");
  const [uri, setUri] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const player = useAudioPlayer(uri ? { uri } : null);
  const playback = useAudioPlayerStatus(player);
  const process = useProcessVoiceQuote();

  const liveSeconds = stage === "recording" ? recState.durationMillis / 1000 : seconds;

  const start = async () => {
    setError(null);
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError(
          Platform.OS === "web"
            ? "The browser blocked the microphone. Allow it for this site and try again."
            : "Terra needs the microphone for this. Turn it on in Settings, then try again.",
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setUri(null);
      setStage("recording");
    } catch {
      setError("Could not start recording. Close other apps using the microphone and try again.");
      setStage("idle");
    }
  };

  const stop = async () => {
    const took = recState.durationMillis / 1000;
    try {
      await recorder.stop();
    } catch {
      // Already stopped. The uri below is still good.
    }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => undefined);
    const recorded = recorder.uri;
    if (!recorded) {
      setError("That recording came out empty. Try again.");
      setStage("idle");
      return;
    }
    setSeconds(took);
    setUri(recorded);
    setStage("recorded");
  };

  // Stops on its own at the limit rather than running forever in a pocket.
  useEffect(() => {
    if (stage === "recording" && recState.durationMillis / 1000 >= MAX_SECONDS) void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, recState.durationMillis]);

  const togglePlay = () => {
    if (playback.playing) {
      player.pause();
      return;
    }
    if (playback.didJustFinish || (playback.duration > 0 && playback.currentTime >= playback.duration - 0.1)) {
      void player.seekTo(0);
    }
    player.play();
  };

  const submit = async () => {
    if (!uri) return;
    if (playback.playing) player.pause();
    setError(null);
    setStage("uploading");
    try {
      let contentType = "audio/mp4";
      let ext = "m4a";
      if (Platform.OS === "web") {
        const type = (await (await fetch(uri)).blob()).type;
        contentType = type || "audio/webm";
        ext = contentType.includes("mp4") ? "m4a" : "webm";
      }
      const audioKey = await uploadVoiceRecording({ uri, filename: `phone-capture.${ext}`, contentType });
      setStage("processing");
      const res = await process.mutateAsync({ audioKey, durationSeconds: Math.round(seconds) });
      setResult(res);
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That recording could not be turned into a quote.");
      setStage("recorded");
    }
  };

  const reset = () => {
    if (playback.playing) player.pause();
    setUri(null);
    setSeconds(0);
    setResult(null);
    setError(null);
    setStage("idle");
  };

  const busy = stage === "uploading" || stage === "processing";

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        <Pressable onPress={() => router.back()} style={{ padding: 4 }} disabled={busy}>
          <Ionicons name="chevron-back" size={24} color={busy ? c.border : c.foreground} />
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>Voice quote</Text>
      </View>

      {stage === "done" && result ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
          <View style={{ alignItems: "center", marginTop: 12 }}>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: result.flaggedCount > 0 ? "#FBF1E0" : "#E4EFE2",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Ionicons
                name={result.flaggedCount > 0 ? "alert" : "checkmark"}
                size={32}
                color={result.flaggedCount > 0 ? c.warning : c.success}
              />
            </View>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground, marginTop: 12 }}>
              Quote #{result.quote.number} drafted
            </Text>
            <Text
              style={{
                fontFamily: Fonts.sans,
                fontSize: 14,
                color: c.mutedForeground,
                textAlign: "center",
                marginTop: 4,
                paddingHorizontal: 12,
              }}
            >
              {result.flaggedCount > 0
                ? `${result.flaggedCount} line${result.flaggedCount === 1 ? "" : "s"} could not be priced for sure. Check ${result.flaggedCount === 1 ? "it" : "them"} before it goes out.`
                : "Every line matched the price book. Give it a once over and send."}
            </Text>
          </View>

          <View style={{ flexDirection: "row", gap: 10, marginTop: 22 }}>
            <Fact label="LINES" value={String(result.lineCount)} />
            <Fact
              label="TO CHECK"
              value={String(result.flaggedCount)}
              tone={result.flaggedCount > 0 ? "warn" : "good"}
            />
          </View>
          <View style={{ marginTop: 10 }}>
            <Fact
              label="CUSTOMER"
              value={result.matchedCustomerName ?? "Not matched, attach on the quote"}
              tone={result.matchedCustomerName ? undefined : "warn"}
            />
          </View>

          <View
            style={{
              backgroundColor: c.muted,
              borderRadius: 14,
              padding: 14,
              marginTop: 16,
            }}
          >
            <Text style={{ fontFamily: Fonts.medium, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}>
              WHAT IT HEARD
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 14, lineHeight: 21, color: c.foreground, marginTop: 6 }}>
              {result.transcript}
            </Text>
          </View>

          <View style={{ gap: 10, marginTop: 22 }}>
            <BigButton
              label="Open the quote"
              icon="open-outline"
              onPress={() => void Linking.openURL(`${siteUrl}/quotes/${result.quote.id}`)}
            />
            <BigButton label="Record another" icon="mic-outline" tone="plain" onPress={reset} />
          </View>
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 20, paddingBottom: 16 }}>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            {busy ? (
              <>
                <ActivityIndicator size="large" color={c.primary} />
                <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground, marginTop: 18 }}>
                  {stage === "uploading" ? "Sending the recording" : "Listening and pricing"}
                </Text>
                <Text
                  style={{
                    fontFamily: Fonts.sans,
                    fontSize: 14,
                    color: c.mutedForeground,
                    textAlign: "center",
                    marginTop: 6,
                    maxWidth: 280,
                  }}
                >
                  {stage === "uploading"
                    ? "Keep the app open."
                    : "Matching what you said to the price book. Usually under half a minute."}
                </Text>
              </>
            ) : (
              <>
                <Text
                  style={{
                    fontFamily: Fonts.bold,
                    fontSize: 52,
                    color: stage === "recording" ? c.destructive : c.foreground,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {clock(liveSeconds)}
                </Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginBottom: 36 }}>
                  {stage === "recording"
                    ? "Recording. Tap to stop."
                    : stage === "recorded"
                      ? "Recorded. Have a listen or send it."
                      : "Tap and talk through the job."}
                </Text>

                <View style={{ width: 150, height: 150, alignItems: "center", justifyContent: "center" }}>
                  <Pulse active={stage === "recording"} />
                  {stage === "recorded" ? (
                    <Pressable
                      onPress={togglePlay}
                      accessibilityLabel={playback.playing ? "Pause the recording" : "Play the recording"}
                      style={({ pressed }) => ({
                        width: 120,
                        height: 120,
                        borderRadius: 60,
                        backgroundColor: c.sidebar,
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: pressed ? 0.85 : 1,
                      })}
                    >
                      <Ionicons
                        name={playback.playing ? "pause" : "play"}
                        size={46}
                        color="#FFFFFF"
                        style={{ marginLeft: playback.playing ? 0 : 5 }}
                      />
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => void (stage === "recording" ? stop() : start())}
                      accessibilityLabel={stage === "recording" ? "Stop recording" : "Start recording"}
                      style={({ pressed }) => ({
                        width: 120,
                        height: 120,
                        borderRadius: 60,
                        backgroundColor: stage === "recording" ? c.destructive : c.primary,
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: pressed ? 0.85 : 1,
                        shadowColor: "#000",
                        shadowOpacity: 0.15,
                        shadowRadius: 12,
                        shadowOffset: { width: 0, height: 6 },
                        elevation: 4,
                      })}
                    >
                      {stage === "recording" ? (
                        <View style={{ width: 36, height: 36, borderRadius: 7, backgroundColor: "#FFFFFF" }} />
                      ) : (
                        <Ionicons name="mic" size={52} color="#FFFFFF" />
                      )}
                    </Pressable>
                  )}
                </View>

                {stage === "recorded" && Number.isFinite(playback.duration) && playback.duration > 0 ? (
                  <View
                    style={{
                      width: 200,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: c.border,
                      marginTop: 24,
                      overflow: "hidden",
                    }}
                  >
                    <View
                      style={{
                        height: 4,
                        width: `${Math.min(100, (playback.currentTime / playback.duration) * 100)}%`,
                        backgroundColor: c.foreground,
                      }}
                    />
                  </View>
                ) : null}

                {error ? (
                  <View
                    style={{
                      flexDirection: "row",
                      gap: 8,
                      alignItems: "flex-start",
                      backgroundColor: "#F7E2DE",
                      borderRadius: 12,
                      padding: 12,
                      marginTop: 28,
                      maxWidth: 340,
                    }}
                  >
                    <Ionicons name="alert-circle" size={18} color={c.destructive} />
                    <Text style={{ flex: 1, fontFamily: Fonts.sans, fontSize: 13.5, color: c.foreground }}>{error}</Text>
                  </View>
                ) : null}
              </>
            )}
          </View>

          {stage === "idle" ? (
            <View style={{ backgroundColor: c.muted, borderRadius: 14, padding: 14 }}>
              <Text style={{ fontFamily: Fonts.bold, fontSize: 13.5, color: c.foreground }}>Say it like this</Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, lineHeight: 20, color: c.mutedForeground, marginTop: 4 }}>
                &quot;Quote for Joe Blow. 40 metres of carpet, 10 straight stairs, five winders, take up 40 metres of old
                carpet.&quot;
              </Text>
            </View>
          ) : null}

          {stage === "recorded" ? (
            <View style={{ gap: 10 }}>
              <BigButton label="Turn into a quote" icon="sparkles-outline" onPress={() => void submit()} />
              <BigButton label="Record again" icon="refresh" tone="plain" onPress={reset} />
            </View>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}
