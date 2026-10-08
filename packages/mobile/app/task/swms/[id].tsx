import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomGap, useBottomInset } from "@/hooks/use-bottom-gap";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Colors, Fonts } from "@/constants/theme";
import { fmtDayLabel } from "@/lib/format";
import * as Location from "expo-location";
import { useReportCheck, useSignSwms, useSwmsForTask } from "@/queries/swms";
import { useStartTask } from "@/queries/field";
import { SignaturePad, type SignatureValue } from "@/components/signature-pad";

const c = Colors.light;

type Data = NonNullable<ReturnType<typeof useSwmsForTask>["data"]>;
type SectionKey = Data["sections"][number]["key"];
type Item = Data["common"][number];
type SiteCheck = NonNullable<Data["siteChecks"]>[number];
type Answer = "yes" | "no" | "unsure" | "na";
type Gps = { status: "ok" | "denied" | "timeout" | "unavailable"; lat: number | null; lng: number | null; accuracy: number | null };

const ANSWER_LABEL: Record<string, string> = { yes: "Yes", no: "No", unsure: "Unsure", na: "N/A" };
const RED = "#B3261E";

/** Where the phone is when it signs. Never holds up signing for more than about 10 seconds. */
async function where(): Promise<Gps> {
  const none = (status: Gps["status"]): Gps => ({ status, lat: null, lng: null, accuracy: null });
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== "granted") return none("denied");
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((r) => setTimeout(() => r(null), 10000)),
    ]);
    if (!fix) {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 }).catch(() => null);
      if (!last) return none("timeout");
      return { status: "ok", lat: last.coords.latitude, lng: last.coords.longitude, accuracy: last.coords.accuracy ?? null };
    }
    return { status: "ok", lat: fix.coords.latitude, lng: fix.coords.longitude, accuracy: fix.coords.accuracy ?? null };
  } catch {
    return none("unavailable");
  }
}

function CheckRow({
  check,
  value,
  onPick,
  disabled,
  last,
}: {
  check: SiteCheck;
  value: string | undefined;
  onPick: (a: Answer) => void;
  disabled: boolean;
  last: boolean;
}) {
  const flagged = !!value && check.flagOn.includes(value);
  return (
    <View style={{ paddingVertical: 12, borderBottomWidth: last ? 0 : 1, borderBottomColor: c.border }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 14.5, color: c.foreground, lineHeight: 20 }}>{check.question}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
        {check.answers.map((a) => {
          const on = value === a;
          const bad = on && check.flagOn.includes(a);
          return (
            <Pressable
              key={a}
              disabled={disabled}
              onPress={() => onPick(a as Answer)}
              style={({ pressed }) => ({
                minWidth: 64,
                alignItems: "center",
                borderWidth: 1.5,
                borderColor: on ? (bad ? RED : c.success) : c.border,
                backgroundColor: on ? (bad ? "#FBE3DF" : "#E4F0E2") : "#FFFFFF",
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 9,
                opacity: pressed || disabled ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: on ? (bad ? RED : "#2F5F2B") : c.foreground }}>
                {ANSWER_LABEL[a] ?? a}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {flagged && !check.blocks ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: "#8A5A11", marginTop: 7, lineHeight: 17 }}>
          The office will be told when you sign. You can still sign and start.
        </Text>
      ) : null}
    </View>
  );
}

function timeOf(d: Date | string) {
  const x = new Date(d);
  return x.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

function Heading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <View style={{ marginTop: 24, marginBottom: 9 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground }}>
        {children}
      </Text>
      {hint ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 3, lineHeight: 17 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 7,
        borderWidth: 1.5,
        borderColor: on ? c.success : c.border,
        backgroundColor: on ? c.success : "#FFFFFF",
        alignItems: "center",
        justifyContent: "center",
        marginTop: 1,
      }}
    >
      {on ? <Ionicons name="checkmark" size={16} color="#FFFFFF" /> : null}
    </View>
  );
}

function HazardRow({
  item,
  on,
  onToggle,
  sds,
  last,
}: {
  item: Item;
  on: boolean;
  onToggle: () => void;
  sds?: { product: string; url: string } | null | undefined;
  last: boolean;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 12,
        paddingVertical: 12,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Tick on={on} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: Fonts.medium, fontSize: 14.5, color: c.foreground, lineHeight: 20 }}>
          {item.label}
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, marginTop: 3, lineHeight: 18 }}>
          {item.controls}
        </Text>
        {item.sds ? (
          sds ? (
            <Pressable onPress={() => void Linking.openURL(sds.url)} hitSlop={6} style={{ marginTop: 6 }}>
              <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.primary }}>
                Safety data sheet: {sds.product}
              </Text>
            </Pressable>
          ) : (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.warning, marginTop: 6 }}>
              Safety data sheet not loaded yet. Ask the office.
            </Text>
          )
        ) : null}
      </View>
    </Pressable>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 2,
      }}
    >
      {children}
    </View>
  );
}

export default function SwmsScreen() {
  const bottomGap = useBottomGap();
  const bottomInset = useBottomInset();
  const { id, then } = useLocalSearchParams<{ id: string; then?: string }>();
  const taskId = Number(id);
  const router = useRouter();
  const q = useSwmsForTask(taskId);
  const sign = useSignSwms();
  const start = useStartTask();
  const report = useReportCheck();

  const [ready, setReady] = useState(false);
  const [common, setCommon] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<SectionKey[]>([]);
  const [ticked, setTicked] = useState<Record<string, Set<string>>>({});
  const [changing, setChanging] = useState(false);
  const [basedOnId, setBasedOnId] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [readOk, setReadOk] = useState(false);
  const [name, setName] = useState("");
  const [sig, setSig] = useState<SignatureValue | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextStep, setNextStep] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, Answer>>({});
  const [locating, setLocating] = useState(false);

  const d = q.data;
  const byKey = useMemo(() => new Map((d?.sections ?? []).map((s) => [s.key, s])), [d]);

  // Start from what the job's labour brings in, every line ticked.
  useEffect(() => {
    if (!d || ready) return;
    setCommon(new Set(d.common.map((i) => i.id)));
    setPicked(d.autoSections);
    const t: Record<string, Set<string>> = {};
    for (const s of d.sections) t[s.key] = new Set(s.items.map((i) => i.id));
    setTicked(t);
    setName(d.prefill.installerName);
    setReady(true);
  }, [d, ready]);

  // Site checks for the work picked: every-job ones plus the picked sections.
  const checks = useMemo(
    () => (d?.siteChecks ?? []).filter((x) => x.appliesAll || x.templateKeys.some((k) => picked.includes(k as SectionKey))),
    [d, picked],
  );
  const stopped = (d?.flags?.open ?? []).filter((f) => f.blocks);

  async function pick(check: SiteCheck, a: Answer) {
    setError(null);
    setAnswers((prev) => ({ ...prev, [check.id]: a }));
    if (!check.blocks || !check.flagOn.includes(a)) return;
    // Stops the job: the office hears now, not at signing.
    try {
      await report.mutateAsync({ taskId, checkId: check.id, answer: a });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reach the office. Call them before you start.");
    }
  }

  function toggleCommon(itemId: string) {
    setBasedOnId(null);
    setCommon((prev) => {
      const n = new Set(prev);
      if (n.has(itemId)) n.delete(itemId);
      else n.add(itemId);
      return n;
    });
  }

  function toggleItem(key: string, itemId: string) {
    setBasedOnId(null);
    setTicked((prev) => {
      const n = new Set(prev[key] ?? []);
      if (n.has(itemId)) n.delete(itemId);
      else n.add(itemId);
      return { ...prev, [key]: n };
    });
  }

  function toggleSection(key: SectionKey) {
    setBasedOnId(null);
    setPicked((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      const order = (d?.sections ?? []).map((s) => s.key);
      return [...prev, key].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    });
  }

  /** Same work as last time on this job: load those ticks, sign as a re-confirm. */
  function loadLastTime() {
    const p = d?.previous;
    if (!p?.ticked || !d) return;
    setCommon(new Set(p.ticked.common));
    const keys = p.ticked.sections.map((s) => s.key).filter((k) => byKey.has(k));
    setPicked(keys);
    setTicked((prev) => {
      const n = { ...prev };
      for (const s of p.ticked!.sections) n[s.key] = new Set(s.checked);
      return n;
    });
    setCustom(p.customHazard ?? "");
    setBasedOnId(p.id);
  }

  async function onSign() {
    if (!d) return;
    setError(null);
    if (!readOk) return setError("Tick that you've read and understood it.");
    if (name.trim().length < 2) return setError("Type your name.");
    if (!sig) return setError("Sign in the box before saving.");
    if (stopped.length) return setError("The office has to clear the red card before you can sign.");
    const missing = checks.find((x) => !answers[x.id]);
    if (missing) return setError(`Answer the site check: "${missing.question}"`);
    setLocating(true);
    const gps = await where();
    setLocating(false);
    try {
      await sign.mutateAsync({
        siteAnswers: d.siteChecks ? checks.map((x) => ({ checkId: x.id, answer: answers[x.id]! })) : undefined,
        gps,
        taskId,
        common: [...common],
        sections: picked.map((k) => ({ key: k, checked: [...(ticked[k] ?? [])] })),
        customHazard: custom.trim(),
        signedName: name.trim(),
        signature: sig,
        basedOnId,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that. Try again.");
      // A red card may have just gone up. Show it.
      void q.refetch();
      return;
    }
    if (then === "start") {
      try {
        await start.mutateAsync({ taskId });
      } catch (e) {
        // Signed and saved. Start has its own checks after this (site walk,
        // checklist), so say what's next and let them go back to the job.
        setNextStep(e instanceof Error ? e.message : "Go back to the job to start it.");
        return;
      }
    }
    router.back();
  }

  const header = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: c.card,
      }}
    >
      <Pressable onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Ionicons name="chevron-back" size={22} color={c.foreground} />
        <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>
          {d ? `Job #${d.prefill.jobNumber}` : "Back"}
        </Text>
      </Pressable>
    </View>
  );

  if (q.isLoading || (d && !ready)) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        {header}
        <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (q.isError || !d) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        {header}
        <View style={{ padding: 20 }}>
          <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.foreground }}>Can't open the SWMS</Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 6 }}>
            {q.error instanceof Error ? q.error.message : "Check your signal and try again, or call the office."}
          </Text>
          <Pressable onPress={() => void q.refetch()} style={{ marginTop: 14 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.primary }}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const signed = d.signedToday;

  if (signed) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        {header}
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 + bottomInset }}>
          <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground }}>SWMS</Text>
          <View
            style={{
              flexDirection: "row",
              gap: 10,
              backgroundColor: "#E4F0E2",
              borderRadius: 12,
              padding: 14,
              marginTop: 14,
            }}
          >
            <Ionicons name="shield-checkmark" size={22} color="#2F5F2B" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: "#2F5F2B" }}>Signed for today</Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: "#2F5F2B", marginTop: 2 }}>
                {signed.signedName}, {timeOf(signed.signedAt)}
                {signed.kind === "reconfirm" ? ". Same as last time." : "."}
              </Text>
            </View>
          </View>
          {nextStep ? (
            <View style={{ backgroundColor: "#FBEDD8", borderRadius: 12, padding: 13, marginTop: 12 }}>
              <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: "#8A5A11" }}>One more thing before you start</Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: "#8A5A11", marginTop: 3, lineHeight: 19 }}>
                {nextStep}
              </Text>
            </View>
          ) : null}
          {signed.pdfUrl ? (
            <Pressable
              onPress={() => void Linking.openURL(signed.pdfUrl!)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                marginTop: 14,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.card,
                borderRadius: 12,
                paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="document-text-outline" size={18} color={c.foreground} />
              <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>Open the signed SWMS</Text>
            </Pressable>
          ) : null}
          {signed.sds.length ? (
            <>
              <Heading>SAFETY DATA SHEETS</Heading>
              <Card>
                {signed.sds.map((s, i) => (
                  <Pressable
                    key={s.id}
                    onPress={() => void Linking.openURL(s.url)}
                    style={{
                      paddingVertical: 13,
                      borderBottomWidth: i === signed.sds.length - 1 ? 0 : 1,
                      borderBottomColor: c.border,
                    }}
                  >
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 14.5, color: c.primary }}>{s.product}</Text>
                  </Pressable>
                ))}
              </Card>
            </>
          ) : null}
          <Pressable
            onPress={() => router.back()}
            style={({ pressed }) => ({
              marginTop: 22,
              backgroundColor: c.primary,
              borderRadius: 14,
              paddingVertical: 16,
              alignItems: "center",
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: "#FFFFFF" }}>Back to the job</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const others = d.sections.filter((s) => !picked.includes(s.key));
  const busy = sign.isPending || start.isPending || locating;
  const blocked = stopped.length > 0;
  const changed = d.previous?.changed ?? [];

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      {header}
      <ScrollView
        scrollEnabled={!drawing}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 140 + bottomInset }}
      >
        <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground }}>Today's SWMS</Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 4, lineHeight: 20 }}>
          {d.prefill.jobTitle}
          {d.prefill.siteAddress ? `\n${d.prefill.siteAddress}` : ""}
          {`\n${fmtDayLabel(d.today)}`}
        </Text>
        {!d.required ? (
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, marginTop: 8 }}>
            This job doesn't need one, but you can still sign it.
          </Text>
        ) : null}

        {d.previous?.ticked ? (
          <Pressable
            onPress={loadLastTime}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginTop: 16,
              backgroundColor: basedOnId ? "#E4F0E2" : c.accent,
              borderRadius: 12,
              padding: 13,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Ionicons
              name={basedOnId ? "checkmark-circle" : "refresh-circle-outline"}
              size={22}
              color={basedOnId ? "#2F5F2B" : c.foreground}
            />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: basedOnId ? "#2F5F2B" : c.foreground }}>
                {basedOnId ? "Loaded from last time" : "Same work as last time?"}
              </Text>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 1 }}>
                {basedOnId
                  ? `Your ticks from ${fmtDayLabel(d.previous.workDate)}. Check them, then sign.`
                  : `Load your ticks from ${fmtDayLabel(d.previous.workDate)}.`}
              </Text>
            </View>
          </Pressable>
        ) : null}

        {changed.length ? (
          <View style={{ backgroundColor: "#FBEDD8", borderRadius: 12, padding: 13, marginTop: 16 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: "#8A5A11" }}>
              The SWMS has changed since you last signed
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: "#8A5A11", marginTop: 2, lineHeight: 17 }}>
              Read it through and sign it in full today.
            </Text>
            {changed.map((ch) => (
              <View key={ch.key} style={{ marginTop: 8 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#8A5A11" }}>
                  {ch.name}: version {ch.from} to {ch.to}
                </Text>
                {ch.notes
                  .filter((n) => n.whatChanged)
                  .map((n) => (
                    <Text key={n.version} style={{ fontFamily: Fonts.sans, fontSize: 13, color: "#8A5A11", marginTop: 2, lineHeight: 18 }}>
                      {`• ${n.whatChanged}`}
                    </Text>
                  ))}
              </View>
            ))}
          </View>
        ) : null}

        <Heading hint="On every job. Untick anything that doesn't apply today.">EVERY JOB</Heading>
        <Card>
          {d.common.map((item, i) => (
            <HazardRow
              key={item.id}
              item={item}
              on={common.has(item.id)}
              onToggle={() => toggleCommon(item.id)}
              last={i === d.common.length - 1}
            />
          ))}
        </Card>

        {picked.map((key) => {
          const s = byKey.get(key);
          if (!s) return null;
          const on = ticked[key] ?? new Set<string>();
          return (
            <View key={key}>
              <Heading hint={s.task}>{s.title.toUpperCase()}</Heading>
              <Card>
                {s.items.map((item, i) => (
                  <HazardRow
                    key={item.id}
                    item={item}
                    on={on.has(item.id)}
                    onToggle={() => toggleItem(key, item.id)}
                    sds={item.sds ? d.sds[item.sds] : undefined}
                    last={i === s.items.length - 1}
                  />
                ))}
              </Card>
            </View>
          );
        })}

        {picked.length === 0 ? (
          <View style={{ backgroundColor: "#FBEDD8", borderRadius: 12, padding: 13, marginTop: 18 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#8A5A11", lineHeight: 19 }}>
              Only the every-job hazards apply to this work. If you're laying, sanding or removing a floor today, add it below.
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={() => setChanging((v) => !v)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 16, paddingVertical: 4 }}
        >
          <Ionicons name={changing ? "chevron-up" : "swap-horizontal"} size={16} color={c.primary} />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.primary }}>
            {changing ? "Done changing the work" : "Wrong work type? Change it"}
          </Text>
        </Pressable>
        {changing ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {[...picked.map((k) => byKey.get(k)!).filter(Boolean), ...others].map((s) => {
              const on = picked.includes(s.key);
              return (
                <Pressable
                  key={s.key}
                  onPress={() => toggleSection(s.key)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    borderWidth: 1,
                    borderColor: on ? c.primary : c.border,
                    backgroundColor: on ? "#F7E6DC" : c.card,
                    borderRadius: 20,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    maxWidth: "100%",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons name={on ? "remove-circle-outline" : "add-circle-outline"} size={16} color={on ? c.primary : c.mutedForeground} />
                  <Text style={{ flexShrink: 1, fontFamily: Fonts.medium, fontSize: 13, color: on ? c.primary : c.foreground }}>
                    {s.title}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <Heading hint="Optional. Anything specific to this site the list doesn't cover.">ANYTHING ELSE ON THIS SITE</Heading>
        <TextInput
          value={custom}
          onChangeText={(v) => {
            setCustom(v);
            setBasedOnId(null);
          }}
          placeholder="e.g. Scaffold at the front door, pets in the yard"
          placeholderTextColor={c.mutedForeground}
          multiline
          maxLength={2000}
          style={{
            minHeight: 70,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 12,
            padding: 12,
            backgroundColor: c.card,
            fontFamily: Fonts.sans,
            fontSize: 14.5,
            color: c.foreground,
            textAlignVertical: "top",
          }}
        />

        {checks.length ? (
          <>
            <Heading hint="Answer each one for this site today.">SITE CHECKS</Heading>
            <Card>
              {checks.map((x, i) => (
                <CheckRow
                  key={x.id}
                  check={x}
                  value={answers[x.id]}
                  onPick={(a) => void pick(x, a)}
                  disabled={report.isPending}
                  last={i === checks.length - 1}
                />
              ))}
            </Card>
          </>
        ) : null}

        {blocked ? (
          <View style={{ borderWidth: 2, borderColor: RED, backgroundColor: "#FBE3DF", borderRadius: 12, padding: 14, marginTop: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="hand-left" size={20} color={RED} />
              <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: RED }}>Do not start</Text>
            </View>
            {stopped.map((f) => (
              <Text key={f.id} style={{ fontFamily: Fonts.medium, fontSize: 14, color: "#8B2F22", marginTop: 6, lineHeight: 19 }}>
                {f.question} {ANSWER_LABEL[f.answer] ?? f.answer}
              </Text>
            ))}
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: "#8B2F22", marginTop: 6, lineHeight: 19 }}>
              The office has been told. Wait for them to call you. You can sign once they clear it.
            </Text>
            <Pressable onPress={() => void q.refetch()} hitSlop={6} style={{ marginTop: 10 }}>
              <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: RED }}>
                {q.isFetching ? "Checking..." : "Check again"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <Heading>SIGN OFF</Heading>
        <Pressable
          onPress={() => setReadOk((v) => !v)}
          style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", paddingVertical: 4 }}
        >
          <Tick on={readOk} />
          <Text style={{ flex: 1, fontFamily: Fonts.medium, fontSize: 14.5, color: c.foreground, lineHeight: 20 }}>
            I have read and understood this SWMS and will follow it.
          </Text>
        </Pressable>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 14 }}>Your name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          maxLength={80}
          style={{
            marginTop: 6,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 12,
            paddingHorizontal: 12,
            paddingVertical: 11,
            backgroundColor: c.card,
            fontFamily: Fonts.sans,
            fontSize: 15,
            color: c.foreground,
          }}
        />
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 14, marginBottom: 6 }}>
          Signature
        </Text>
        <SignaturePad onChange={setSig} onDrawingChange={setDrawing} />
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 6, lineHeight: 17 }}>
          If the scope changes on site, like asbestos found or work at height, stop work and call the office.
        </Text>

        {error ? (
          <View style={{ backgroundColor: "#FBE3DF", borderRadius: 10, padding: 12, marginTop: 14 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: "#8B2F22" }}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: 16,
          paddingBottom: bottomGap,
          backgroundColor: c.card,
          borderTopWidth: 1,
          borderTopColor: c.border,
        }}
      >
        <Pressable
          disabled={busy || blocked}
          onPress={() => void onSign()}
          style={({ pressed }) => ({
            backgroundColor: blocked ? c.mutedForeground : c.primary,
            borderRadius: 14,
            paddingVertical: 17,
            alignItems: "center",
            opacity: pressed || busy ? 0.8 : 1,
          })}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={{ fontFamily: Fonts.bold, fontSize: 16.5, color: "#FFFFFF" }}>
              {blocked ? "Waiting for the office" : then === "start" ? "Sign and start the job" : "Sign the SWMS"}
            </Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
