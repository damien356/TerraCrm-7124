import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts } from "@/constants/theme";
import { fmtDayLabel } from "@/lib/format";
import {
  STATUS_TEXT,
  type SavedTap,
  type TapKind,
  clearTap,
  clock,
  dollars,
  errorText,
  hrsMins,
  newClientKey,
  saveTap,
  savedTap,
  serverAnswered,
  useAskOfficeToFix,
  useFinishWork,
  useMyTime,
  usePauseWork,
  useResumeWork,
  useStartWork,
} from "@/queries/hourly";

const c = Colors.light;

type MyTime = NonNullable<ReturnType<typeof useMyTime>["data"]>;
type Entry = MyTime["sessions"][number];

const TAP_LABEL: Record<TapKind, string> = {
  start: "Start work",
  pause: "Break",
  resume: "Resume",
  finish: "Finish work today",
};

function Big({
  label,
  icon,
  onPress,
  tone = "primary",
  busy,
}: {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  tone?: "primary" | "plain" | "danger";
  busy?: boolean;
}) {
  const bg = tone === "primary" ? c.primary : c.card;
  const fg = tone === "primary" ? c.primaryForeground : tone === "danger" ? c.destructive : c.foreground;
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        backgroundColor: bg,
        borderWidth: tone === "primary" ? 0 : 1,
        borderColor: tone === "danger" ? c.destructive : c.border,
        borderRadius: 12,
        paddingVertical: 15,
        opacity: pressed || busy ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={fg} size="small" /> : <Ionicons name={icon} size={18} color={fg} />}
      <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: fg }}>{label}</Text>
    </Pressable>
  );
}

function Pick({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: on ? c.primary : c.border,
        backgroundColor: on ? "#F7E6DC" : c.card,
      }}
    >
      <Text style={{ fontFamily: on ? Fonts.medium : Fonts.sans, fontSize: 12.5, color: on ? c.primary : c.foreground }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Row({ left, right, strong }: { left: string; right: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 }}>
      <Text style={{ fontFamily: strong ? Fonts.bold : Fonts.sans, fontSize: strong ? 15 : 13, color: strong ? c.foreground : c.mutedForeground }}>
        {left}
      </Text>
      <Text style={{ fontFamily: strong ? Fonts.bold : Fonts.medium, fontSize: strong ? 16 : 13.5, color: strong ? c.primary : c.foreground }}>
        {right}
      </Text>
    </View>
  );
}

function EntryRow({ e, first, onFix }: { e: Entry; first: boolean; onFix: (e: Entry) => void }) {
  const tone =
    e.status === "approved" ? { bg: "#E4F0E2", fg: "#2F5F2B" } : e.status === "open" ? { bg: "#F7E6DC", fg: c.primary } : { bg: "#FBEDD8", fg: "#8A5A11" };
  const breakMins = e.breaks.reduce((a, b) => {
    const s = Date.parse(b.start);
    const t = b.end ? Date.parse(b.end) : Date.now();
    return a + Math.max(0, Math.round((t - s) / 60_000));
  }, 0);
  return (
    <View style={{ borderTopWidth: first ? 0 : 1, borderTopColor: c.border, paddingVertical: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>
          {fmtDayLabel(e.workDate)} · {e.categoryLabel}
        </Text>
        <View style={{ backgroundColor: tone.bg, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 }}>
          <Text style={{ fontFamily: Fonts.medium, fontSize: 11, color: tone.fg }}>
            {e.status === "open" && e.breaks.some((x) => !x.end) ? "On a break" : (STATUS_TEXT[e.status] ?? e.status)}
          </Text>
        </View>
      </View>
      <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.foreground, marginTop: 4 }}>
        {clock(e.start)} to {e.end ? clock(e.end) : "now"}
        {e.breaks.length > 0 ? `  ·  break ${hrsMins(breakMins)}` : ""}
      </Text>
      {e.corrected ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>
          Office corrected this. {e.recordedEnd
            ? `You recorded ${clock(e.recordedStart)} to ${clock(e.recordedEnd)}.`
            : `You recorded a start of ${clock(e.recordedStart)} with no finish.`}
        </Text>
      ) : null}
      {e.status === "approved" ? (
        <View style={{ marginTop: 6 }}>
          {(e.payLines ?? []).map((l, i) => (
            <Row key={i} left={`${l.label} · ${hrsMins(l.minutes)} @ ${dollars(l.rate)}/hr`} right={dollars(l.total)} />
          ))}
          <Row left={`Approved ${hrsMins(e.approvedMinutes)}`} right={dollars(e.approvedPay)} />
        </View>
      ) : e.status === "open" ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 3 }}>
          Still running. Tap Finish today when you stop.
        </Text>
      ) : e.recordedMinutes != null ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 3 }}>
          {hrsMins(e.recordedMinutes)} recorded. Pay shows once the office approves it.
        </Text>
      ) : null}
      {e.correctionRequestedAt ? (
        <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: "#8A5A11", marginTop: 4 }}>
          You asked the office to fix this one.
        </Text>
      ) : e.status !== "approved" && e.status !== "open" ? (
        <Pressable onPress={() => onFix(e)} style={{ marginTop: 6, alignSelf: "flex-start" }}>
          <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.primary }}>Wrong? Ask the office to fix it</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The hourly time card on a task. Shown in place of YOUR PAY when the task is
 * hourly and the worker is set up for hourly time. Anything else (an old
 * server, a man not on hourly terms) shows the ordinary pay card instead.
 */
export function HourlyTimeSection({
  taskId,
  closed,
  fallback,
  beforeStart,
}: {
  taskId: number;
  closed: boolean;
  fallback: React.ReactNode;
  /** A check before clocking on (today's SWMS for site work). False means stop here. */
  beforeStart?: (category: string) => Promise<boolean>;
}) {
  const time = useMyTime(taskId);
  const start = useStartWork();
  const pause = usePauseWork();
  const resume = useResumeWork();
  const finish = useFinishWork();
  const askFix = useAskOfficeToFix();

  const [category, setCategory] = useState<string>("site");
  const [vehicleId, setVehicleId] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<SavedTap | null>(() => savedTap(taskId));
  const [fixing, setFixing] = useState<Entry | null>(null);
  const [fixText, setFixText] = useState("");
  const [fixSent, setFixSent] = useState(false);

  if (time.isLoading) return <ActivityIndicator color={c.primary} style={{ marginTop: 22 }} />;
  const d = time.data;
  if (time.isError || !d || !d.enabled) return <>{fallback}</>;

  const here = d.open && d.open.taskId === taskId ? d.open : null;
  const onBreak = Boolean(here?.onBreak);
  const busy = start.isPending || pause.isPending || resume.isPending || finish.isPending;
  const r = d.rates;
  const gst = Boolean(r?.gstRegistered);
  // A saved tap the server already has (the answer was lost) no longer matches the buttons. Ignore it.
  const stale =
    pending &&
    ((pending.kind === "start" && here) ||
      (pending.kind !== "start" && !here) ||
      (pending.kind === "pause" && onBreak) ||
      (pending.kind === "resume" && !onBreak));
  const live = pending && !stale ? pending : null;
  const chosenVehicle = vehicleId === undefined ? (d.vehicles.find((v) => v.mine)?.id ?? null) : vehicleId;

  /** Send a tap. A tap that never reached the server is kept with its time and key, to send again. */
  async function send(kind: TapKind) {
    setError(null);
    const again = live && live.kind === kind ? live : null;
    // The time is the moment of the tap, not when the server hears about it.
    const tap: SavedTap = again ?? {
      kind,
      clientKey: newClientKey(),
      at: new Date().toISOString(),
      sessionId: here?.id ?? null,
    };
    if (kind === "start" && beforeStart && !(await beforeStart(category))) return;
    saveTap(taskId, tap);
    setPending(tap);
    try {
      if (kind === "start") {
        await start.mutateAsync({ taskId, clientKey: tap.clientKey, at: tap.at, category: category as never, vehicleId: chosenVehicle });
      } else {
        const sessionId = tap.sessionId ?? here?.id;
        if (!sessionId) throw new Error("You are not on the clock on this job.");
        if (kind === "pause") await pause.mutateAsync({ sessionId, clientKey: tap.clientKey, at: tap.at });
        if (kind === "resume") await resume.mutateAsync({ sessionId, at: tap.at });
        if (kind === "finish") await finish.mutateAsync({ sessionId, at: tap.at });
      }
      clearTap(taskId);
      setPending(null);
    } catch (e) {
      if (serverAnswered(e) || (e instanceof Error && e.message.startsWith("You are not on the clock"))) {
        clearTap(taskId);
        setPending(null);
        setError(errorText(e, "That didn't go through."));
      } else {
        setError(`No signal. Your ${TAP_LABEL[kind]} at ${clock(tap.at)} is saved on this phone. Tap ${TAP_LABEL[kind]} again to send it.`);
      }
    }
  }

  async function sendFix() {
    if (!fixing || fixText.trim().length < 3) return;
    setError(null);
    try {
      await askFix.mutateAsync({ sessionId: fixing.id, note: fixText.trim() });
      setFixing(null);
      setFixText("");
      setFixSent(true);
    } catch (e) {
      setError(errorText(e, "Couldn't send that. Try again, or ring the office."));
    }
  }

  const waiting = d.recordedMinutes;

  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground, marginBottom: 9 }}>
        YOUR TIME AND PAY
      </Text>
      <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14 }}>
        {r ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 22, color: c.foreground }}>
              {dollars(r.standardRate)}
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}> /hr{gst ? " +GST" : ""}</Text>
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 3 }}>
              Weekend daytime {dollars(r.weekendRate)}/hr · Night {dollars(r.nightRate)}/hr
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>
              {gst ? "Rates are ex GST. GST is added on your invoice." : "Not GST registered, so no GST on this pay."}
            </Text>
          </View>
        ) : null}

        {here ? (
          <View style={{ backgroundColor: "#F7E6DC", borderRadius: 10, padding: 10, marginBottom: 10 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.primary }}>
              {onBreak ? "On a break" : "On the clock"} · {here.categoryLabel}
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.foreground, marginTop: 2 }}>
              Started {clock(here.start)}
              {onBreak ? `, break since ${clock(here.breaks.find((b) => !b.end)?.start)}` : ""}
            </Text>
          </View>
        ) : null}

        {d.openElsewhere && !here ? (
          <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: "#8A5A11", marginBottom: 10 }}>
            You are still on the clock on another job. Finish that one first.
          </Text>
        ) : null}

        {!here && !d.openElsewhere && !closed ? (
          <View style={{ marginBottom: 10 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: c.mutedForeground, marginBottom: 6 }}>What are you doing?</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {d.categories.map((k) => (
                <Pick key={k.id} label={k.label} on={category === k.id} onPress={() => setCategory(k.id)} />
              ))}
            </View>
            {d.vehicles.length > 0 ? (
              <>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: c.mutedForeground, marginTop: 10, marginBottom: 6 }}>
                  Vehicle
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {d.vehicles.map((v) => (
                    <Pick key={v.id} label={v.name} on={chosenVehicle === v.id} onPress={() => setVehicleId(v.id)} />
                  ))}
                  <Pick label="No vehicle" on={chosenVehicle === null} onPress={() => setVehicleId(null)} />
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        {!closed || here ? (
          <View style={{ gap: 8 }}>
            {!here && !d.openElsewhere ? (
              <View style={{ flexDirection: "row" }}>
                <Big label={TAP_LABEL.start} icon="play" busy={busy} onPress={() => void send("start")} />
              </View>
            ) : null}
            {here ? (
              <View style={{ flexDirection: "row", gap: 8 }}>
                {onBreak ? (
                  <Big label={TAP_LABEL.resume} icon="play" busy={busy} onPress={() => void send("resume")} />
                ) : (
                  <Big label={TAP_LABEL.pause} icon="cafe-outline" tone="plain" busy={busy} onPress={() => void send("pause")} />
                )}
                <Big label="Finish today" icon="stop" tone={onBreak ? "plain" : "primary"} busy={busy} onPress={() => void send("finish")} />
              </View>
            ) : null}
            <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground }}>
              {here
                ? "Finish today stops your time. It does not complete the job."
                : "Start work starts your time. The job buttons below are separate."}
            </Text>
          </View>
        ) : null}

        {live && !error ? (
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: busy ? c.mutedForeground : "#8A5A11", marginTop: 8 }}>
            {busy
              ? `Sending your ${TAP_LABEL[live.kind]} from ${clock(live.at)}...`
              : `Your ${TAP_LABEL[live.kind]} from ${clock(live.at)} has not reached the office yet. Tap ${TAP_LABEL[live.kind]} again to send it.`}
          </Text>
        ) : null}
        {error ? (
          <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.destructive, marginTop: 8 }}>{error}</Text>
        ) : null}

        <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 12, paddingTop: 8 }}>
          <Row left={`Approved ${hrsMins(d.approvedMinutes)}`} right={dollars(d.approvedPay)} strong />
          {waiting > 0 ? <Row left="Waiting for the office" right={hrsMins(waiting)} /> : null}
          <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground, marginTop: 4 }}>
            Only approved time is paid. The office checks every day before it is approved.
          </Text>
        </View>
      </View>

      {d.sessions.length > 0 ? (
        <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 4, marginTop: 10 }}>
          {[...d.sessions]
            .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
            .map((e, i) => (
              <EntryRow
                key={e.id}
                e={e}
                first={i === 0}
                onFix={(x) => {
                  setFixSent(false);
                  setFixText("");
                  setFixing(x);
                }}
              />
            ))}
        </View>
      ) : null}

      {fixSent ? (
        <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.success, marginTop: 8 }}>
          Sent. The office will fix it and you will see the change here.
        </Text>
      ) : null}

      {fixing ? (
        <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.primary, borderRadius: 14, padding: 14, marginTop: 10 }}>
          <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>
            What is wrong with {fmtDayLabel(fixing.workDate)}?
          </Text>
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>
            For example: I forgot to tap Finish, I left at 3:30pm.
          </Text>
          <TextInput
            value={fixText}
            onChangeText={setFixText}
            multiline
            placeholder="Tell the office"
            placeholderTextColor={c.mutedForeground}
            style={{
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 10,
              padding: 10,
              minHeight: 70,
              marginTop: 8,
              fontFamily: Fonts.sans,
              fontSize: 14,
              color: c.foreground,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
            <Big label="Cancel" icon="close" tone="plain" onPress={() => setFixing(null)} />
            <Big label="Send" icon="send" busy={askFix.isPending} onPress={() => void sendFix()} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
