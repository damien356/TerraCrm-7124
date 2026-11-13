import { useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useBottomInset } from "@/hooks/use-bottom-gap";
import { Colors, Fonts } from "@/constants/theme";
import { addDaysISO, fmtDayLabel, todayISO } from "@/lib/format";
import { HourlyTimeSection } from "@/components/hourly-time";
import { useClockOutReminder } from "@/lib/clock-reminder";
import { dollars, errorText, hrsMins, savedTap, serverAnswered, useMyHourlySummary } from "@/queries/hourly";
import {
  type Period,
  newRequestKey,
  useInvoicePreview,
  useInvoicingReady,
  useIssueInvoice,
  useMyHourlyJobs,
  useMyInvoiceSummary,
  useMyPeriodInvoices,
  usePeriodInvoicePdf,
  useResendInvoice,
} from "@/queries/hourly-invoices";

/**
 * MY HOURS & INVOICES (Damien, 13 Nov 2026).
 *
 * One screen for a contractor paid by the hour:
 *  - My time: pick the job, then Start work, Start break / End break, Finish
 *    work. A tap with no signal is kept on the phone and shows as not sent;
 *  - Create invoice: Today, This week (Monday to Sunday) or Choose dates, tick
 *    the entries, Preview, then Issue & send to Terra;
 *  - My invoices: the PDF, Send again, Awaiting payment, Part paid and Paid.
 *
 * Every figure comes from the server and is his own. The phone never works
 * out pay, GST or a total itself.
 */

const c = Colors.light;
type Tab = "time" | "invoice" | "invoices";

const BADGE: Record<string, { bg: string; fg: string }> = {
  paid: { bg: "#E4F0E2", fg: "#2F5F2B" },
  part_paid: { bg: "#FBEDD8", fg: "#8A5A11" },
  awaiting_payment: { bg: "#EEF0F3", fg: "#3C4654" },
};

function shortDate(iso?: string | null) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()]} ${dt.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][dt.getMonth()]}`;
}

function Label({ children }: { children: string }) {
  return (
    <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground, marginBottom: 8, marginTop: 18 }}>
      {children}
    </Text>
  );
}

function Card({ children, border }: { children: React.ReactNode; border?: string }) {
  return (
    <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: border ?? c.border, borderRadius: 14, padding: 14, marginBottom: 10 }}>
      {children}
    </View>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 12 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 9.5, letterSpacing: 1, color: c.mutedForeground }}>{label}</Text>
      <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.foreground, marginTop: 3 }}>{value}</Text>
      {hint ? <Text style={{ fontFamily: Fonts.sans, fontSize: 11, color: c.mutedForeground }}>{hint}</Text> : null}
    </View>
  );
}

function Chip({ label, on, onPress, dot }: { label: string; on: boolean; onPress: () => void; dot?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: on ? c.primary : c.border,
        backgroundColor: on ? "#F7E6DC" : c.card,
      }}
    >
      {dot ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: "#C27C0E" }} /> : null}
      <Text style={{ fontFamily: on ? Fonts.medium : Fonts.sans, fontSize: 13, color: on ? c.primary : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

function Button({
  label,
  onPress,
  tone = "primary",
  busy,
  disabled,
  icon,
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "plain";
  busy?: boolean;
  disabled?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
}) {
  const off = disabled || busy;
  const bg = tone === "primary" ? c.primary : c.card;
  const fg = tone === "primary" ? c.primaryForeground : c.foreground;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flex: 1,
        flexDirection: "row",
        gap: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
        borderWidth: tone === "primary" ? 0 : 1,
        borderColor: c.border,
        borderRadius: 12,
        paddingVertical: 14,
        opacity: disabled ? 0.45 : pressed || busy ? 0.7 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Ionicons name={icon} size={17} color={fg} /> : null}
      <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: fg }}>{label}</Text>
    </Pressable>
  );
}

function Line({ left, right, strong, muted }: { left: string; right: string; strong?: boolean; muted?: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, paddingVertical: 3 }}>
      <Text style={{ flex: 1, fontFamily: strong ? Fonts.bold : Fonts.sans, fontSize: strong ? 15 : 13, color: muted ? c.mutedForeground : c.foreground }}>{left}</Text>
      <Text style={{ fontFamily: strong ? Fonts.bold : Fonts.medium, fontSize: strong ? 16 : 13.5, color: strong ? c.primary : c.foreground }}>{right}</Text>
    </View>
  );
}

function Note({ text, tone = "muted" }: { text: string; tone?: "muted" | "warn" | "error" | "ok" }) {
  const color = tone === "warn" ? "#8A5A11" : tone === "error" ? c.destructive : tone === "ok" ? c.success : c.mutedForeground;
  return <Text style={{ fontFamily: tone === "muted" ? Fonts.sans : Fonts.medium, fontSize: 12.5, color, marginTop: 6, lineHeight: 18 }}>{text}</Text>;
}

/* ------------------------------ My time ------------------------------ */

function MyTime({ openTaskId }: { openTaskId: number | null }) {
  const router = useRouter();
  const jobs = useMyHourlyJobs();
  const [picked, setPicked] = useState<number | null>(null);
  const list = jobs.data ?? [];
  const today = todayISO();
  const fallback = list.find((j) => j.scheduledDate === today)?.taskId ?? list[0]?.taskId ?? null;
  const chosenId = picked ?? (openTaskId && list.some((j) => j.taskId === openTaskId) ? openTaskId : fallback);
  const chosen = list.find((j) => j.taskId === chosenId) ?? null;
  const unsent = list.filter((j) => savedTap(j.taskId));

  if (jobs.isLoading) return <ActivityIndicator color={c.primary} style={{ marginTop: 24 }} />;
  if (jobs.isError) return <Note tone="error" text="Couldn't load your jobs. Pull down to try again." />;
  if (list.length === 0) {
    return (
      <Card>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>No hourly jobs right now</Text>
        <Note text="When Terra office books you on a job paid by the hour, it shows here to start your time." />
      </Card>
    );
  }

  return (
    <View>
      {unsent.length > 0 ? (
        <Card border="#C27C0E">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Ionicons name="cloud-offline-outline" size={18} color="#8A5A11" />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: "#8A5A11" }}>
              {unsent.length === 1 ? "1 job has a tap not sent yet" : `${unsent.length} jobs have a tap not sent yet`}
            </Text>
          </View>
          <Note text="It is saved on this phone with the time you tapped. Open the job marked with a dot and tap the same button again when you have signal. It can't go on an invoice until the office has it and approves it." />
        </Card>
      ) : null}

      <Label>WHICH JOB?</Label>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>
        {list.map((j) => (
          <Chip
            key={j.taskId}
            label={`${j.taskRef}${j.taskId === openTaskId ? " · on the clock" : ""}`}
            on={j.taskId === chosenId}
            dot={unsent.some((u) => u.taskId === j.taskId)}
            onPress={() => setPicked(j.taskId)}
          />
        ))}
      </View>

      {chosen ? (
        <>
          <Pressable onPress={() => router.push(`/task/${chosen.taskId}`)} style={{ marginTop: 10 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>{chosen.title}</Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 1 }}>
              {chosen.scheduledDate ? fmtDayLabel(chosen.scheduledDate) : "Not booked in yet"} · Open the job
            </Text>
          </Pressable>
          {chosen.swmsDue ? (
            <Pressable onPress={() => router.push(`/task/swms/${chosen.taskId}`)} style={{ marginTop: 8 }}>
              <Note tone="warn" text="Today's SWMS is needed before site work on this job. Tap here to sign it." />
            </Pressable>
          ) : null}
          <HourlyTimeSection
            key={chosen.taskId}
            taskId={chosen.taskId}
            closed={false}
            wording="hours"
            fallback={<Note tone="warn" text="Hourly time isn't set up for this job. Ask Terra office." />}
            beforeStart={async (category) => {
              // Site work on a SWMS job needs today's SWMS first, the same rule as the job screen.
              if (category === "site" && chosen.swmsDue) {
                router.push(`/task/swms/${chosen.taskId}`);
                return false;
              }
              return true;
            }}
          />
        </>
      ) : null}
    </View>
  );
}

/* ------------------------------ Create invoice ------------------------------ */

type PeriodKind = Period["kind"];

function DateStep({ label, value, onChange, max }: { label: string; value: string; onChange: (v: string) => void; max: string }) {
  const atMax = value >= max;
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 11.5, color: c.mutedForeground, marginBottom: 4 }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: c.card }}>
        <Pressable accessibilityLabel={`${label} a day earlier`} onPress={() => onChange(addDaysISO(value, -1))} style={{ padding: 9 }}>
          <Ionicons name="chevron-back" size={18} color={c.foreground} />
        </Pressable>
        <Text style={{ flex: 1, textAlign: "center", fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>{shortDate(value)}</Text>
        <Pressable
          accessibilityLabel={`${label} a day later`}
          disabled={atMax}
          onPress={() => onChange(addDaysISO(value, 1))}
          style={{ padding: 9, opacity: atMax ? 0.3 : 1 }}
        >
          <Ionicons name="chevron-forward" size={18} color={c.foreground} />
        </Pressable>
      </View>
    </View>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 1.5,
        borderColor: on ? c.primary : c.border,
        backgroundColor: on ? c.primary : c.card,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on ? <Ionicons name="checkmark" size={15} color={c.primaryForeground} /> : null}
    </View>
  );
}

function CreateInvoice({ onIssued }: { onIssued: () => void }) {
  const today = todayISO();
  const [kind, setKind] = useState<PeriodKind>("week");
  const [from, setFrom] = useState(addDaysISO(today, -6));
  const [to, setTo] = useState(today);
  const [unticked, setUnticked] = useState<number[]>([]);
  const [step, setStep] = useState<"pick" | "preview" | "done">("pick");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ number: number; sent: boolean; sendError: string | null; repeated: boolean } | null>(null);
  // One key per Issue: kept for a retry on bad signal, so a second tap can never make a second invoice.
  const requestKey = useRef<string | null>(null);
  const issue = useIssueInvoice();

  const period: Period = kind === "dates" ? { kind, from: from <= to ? from : to, to: from <= to ? to : from } : { kind };
  const all = useInvoicePreview(period);
  const readyIds = (all.data?.entries ?? []).map((e) => e.id);
  const chosenIds = readyIds.filter((id) => !unticked.includes(id));
  const partial = chosenIds.length > 0 && chosenIds.length < readyIds.length;
  const chosen = useInvoicePreview(partial ? period : null, chosenIds);
  const p = partial ? (chosen.data ?? null) : (all.data ?? null);

  function pickKind(k: PeriodKind) {
    setKind(k);
    setUnticked([]);
    setError(null);
    setStep("pick");
  }

  function toggle(id: number) {
    setUnticked((u) => (u.includes(id) ? u.filter((x) => x !== id) : [...u, id]));
  }

  async function doIssue() {
    if (!p || !p.canIssue || chosenIds.length === 0) return;
    setError(null);
    if (!requestKey.current) requestKey.current = newRequestKey();
    try {
      const r = await issue.mutateAsync({ period, sessionIds: partial ? chosenIds : undefined, requestKey: requestKey.current });
      requestKey.current = null;
      setResult({ number: r.invoice.invoiceNumber, sent: r.sentToTerra, sendError: r.error, repeated: r.repeated });
      setUnticked([]);
      setStep("done");
    } catch (e) {
      if (serverAnswered(e)) {
        requestKey.current = null;
        setError(errorText(e, "That didn't go through."));
      } else {
        setError("No signal. Nothing has been lost. Tap Issue & send to Terra again when you have signal. It will not make a second invoice.");
      }
    }
  }

  const ready = useInvoicingReady();
  if (ready.data && !ready.data.ready) {
    return (
      <Card>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>Not switched on yet</Text>
        <Note text="Invoicing by dates is not switched on yet. Terra office will let you know." />
      </Card>
    );
  }

  if (step === "done" && result) {
    return (
      <Card border={c.success}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="checkmark-circle" size={22} color={c.success} />
          <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: c.foreground }}>Invoice #{result.number} issued</Text>
        </View>
        {result.repeated ? <Note text="This invoice was already issued. Nothing was made twice." /> : null}
        {result.sent ? (
          <Note tone="ok" text="Sent to Terra. You'll see it under My invoices." />
        ) : (
          <Note tone="warn" text={`The invoice is saved, but sending it to Terra didn't work${result.sendError ? ` (${result.sendError})` : ""}. Tap Send again under My invoices.`} />
        )}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
          <Button label="Another invoice" tone="plain" onPress={() => { setResult(null); setStep("pick"); }} />
          <Button label="My invoices" onPress={onIssued} />
        </View>
      </Card>
    );
  }

  if (step === "preview" && p) {
    return (
      <View>
        <Card>
          <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.foreground }}>{p.title}</Text>
          <Note text={`From ${p.from_.billName}${p.from_.abn ? `, ABN ${p.from_.abn}` : ""}`} />
          <Note text="To Terra Flooring" />
          <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 10, paddingTop: 8 }}>
            {p.nextInvoiceNumber != null ? <Line left="Invoice number" right={`#${p.nextInvoiceNumber}`} muted /> : null}
            <Line left="Issued" right={shortDate(p.issueDate)} muted />
            <Line left="Work dates" right={p.from === p.to ? shortDate(p.from) : `${shortDate(p.from)} to ${shortDate(p.to)}`} muted />
            <Line left={`Due (${p.termsDays} days)`} right={shortDate(p.dueDate)} muted />
          </View>
          <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 8, paddingTop: 8 }}>
            {p.lines.map((l, i) => (
              <View key={i} style={{ paddingVertical: 4 }}>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.foreground }}>{l.description}</Text>
                <Line left={`${l.qty} h @ ${dollars(l.rate)}/h`} right={dollars(l.total)} muted />
              </View>
            ))}
          </View>
          <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 8, paddingTop: 8 }}>
            <Line left={`Subtotal, ${p.hours} h`} right={dollars(p.subtotal)} />
            <Line left="GST" right={p.gstRegistered ? dollars(p.gstAmount) : "None"} />
            <Line left="Total" right={dollars(p.total)} strong />
            <Note text={p.gstNote} />
          </View>
        </Card>
        {p.blockedReason ? <Note tone="warn" text={p.blockedReason} /> : null}
        {error ? <Note tone="error" text={error} /> : null}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          <Button label="Back" tone="plain" icon="chevron-back" onPress={() => { requestKey.current = null; setError(null); setStep("pick"); }} />
          <Button label="Issue & send to Terra" icon="send" busy={issue.isPending} disabled={!p.canIssue} onPress={() => void doIssue()} />
        </View>
        <Note text="Once issued the invoice can't be changed here. If something is wrong, ring Terra office." />
      </View>
    );
  }

  const loading = all.isLoading || (partial && chosen.isLoading && !chosen.data);
  return (
    <View>
      <Label>WHICH DATES?</Label>
      <View style={{ flexDirection: "row", gap: 7 }}>
        <Chip label="Today" on={kind === "today"} onPress={() => pickKind("today")} />
        <Chip label="This week" on={kind === "week"} onPress={() => pickKind("week")} />
        <Chip label="Choose dates" on={kind === "dates"} onPress={() => pickKind("dates")} />
      </View>
      {kind === "dates" ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
          <DateStep label="From" value={from} max={today} onChange={(v) => { setFrom(v); setUnticked([]); }} />
          <DateStep label="To" value={to} max={today} onChange={(v) => { setTo(v); setUnticked([]); }} />
        </View>
      ) : null}
      {all.data ? (
        <Note text={all.data.from === all.data.to ? `Work on ${shortDate(all.data.from)}.` : `Work from ${shortDate(all.data.from)} to ${shortDate(all.data.to)}${kind === "week" ? ", Monday to Sunday" : ""}.`} />
      ) : null}

      {loading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 20 }} />
      ) : all.isError ? (
        <Note tone="error" text={errorText(all.error, "Couldn't load your time. Pull down to try again.")} />
      ) : all.data ? (
        <>
          <Label>READY TO INVOICE</Label>
          {all.data.entries.length === 0 ? (
            <Note text="Nothing approved and ready in these dates." />
          ) : (
            <Card>
              {all.data.entries.map((e, i) => {
                const on = !unticked.includes(e.id);
                return (
                  <Pressable
                    key={e.id}
                    onPress={() => toggle(e.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}
                  >
                    <Tick on={on} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>
                        {shortDate(e.workDate)} · {e.taskRef}
                      </Text>
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }} numberOfLines={1}>
                        {e.taskTitle} · {hrsMins(e.minutes)}
                      </Text>
                    </View>
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>{dollars(e.amount)}</Text>
                  </Pressable>
                );
              })}
            </Card>
          )}

          {all.data.held.length > 0 ? (
            <>
              <Label>NOT READY YET</Label>
              <Card>
                {all.data.held.map((e, i) => (
                  <View key={e.id} style={{ paddingVertical: 8, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border }}>
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>
                      {shortDate(e.workDate)} · {e.taskRef}
                    </Text>
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: "#8A5A11", marginTop: 1 }}>{e.reason}</Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {all.data.billed.length > 0 ? (
            <Note text={`${all.data.billed.length} ${all.data.billed.length === 1 ? "entry is" : "entries are"} already on an invoice, so ${all.data.billed.length === 1 ? "it is" : "they are"} left off.`} />
          ) : null}

          {p && chosenIds.length > 0 ? (
            <Card>
              <Line left={`${chosenIds.length} ${chosenIds.length === 1 ? "entry" : "entries"}, ${p.hours} h`} right={dollars(p.subtotal)} />
              {p.gstRegistered ? <Line left="GST" right={dollars(p.gstAmount)} /> : null}
              <Line left="Total" right={dollars(p.total)} strong />
            </Card>
          ) : null}
          {p?.blockedReason ? <Note tone="warn" text={p.blockedReason} /> : null}
          {readyIds.length > 0 && chosenIds.length === 0 ? <Note tone="warn" text="Tick at least one entry." /> : null}
          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Button
              label="Preview"
              icon="document-text-outline"
              disabled={!p || !p.canIssue || chosenIds.length === 0}
              onPress={() => {
                requestKey.current = null;
                setError(null);
                setStep("preview");
              }}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/* ------------------------------ My invoices ------------------------------ */

function MyInvoices() {
  const list = useMyPeriodInvoices();
  const pdf = usePeriodInvoicePdf();
  const resend = useResendInvoice();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: number; text: string; tone: "ok" | "error" } | null>(null);

  async function openPdf(id: number) {
    setBusy(`pdf-${id}`);
    setMsg(null);
    try {
      const r = await pdf.mutateAsync({ invoiceId: id });
      await Linking.openURL(r.url);
    } catch (e) {
      setMsg({ id, text: errorText(e, "Couldn't open the PDF. Try again."), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function sendAgain(id: number) {
    setBusy(`send-${id}`);
    setMsg(null);
    try {
      await resend.mutateAsync({ invoiceId: id });
      setMsg({ id, text: "Sent to Terra again.", tone: "ok" });
    } catch (e) {
      setMsg({ id, text: errorText(e, "Sending failed. Try again shortly."), tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  if (list.isLoading) return <ActivityIndicator color={c.primary} style={{ marginTop: 24 }} />;
  if (list.isError) return <Note tone="error" text="Couldn't load your invoices. Pull down to try again." />;
  const rows = list.data ?? [];
  if (rows.length === 0) return <Note text="No invoices yet. Use Create invoice when you have approved time." />;

  return (
    <View style={{ marginTop: 12 }}>
      {rows.map((i) => {
        const tone = BADGE[i.state] ?? BADGE.awaiting_payment;
        const period = i.kind === "period";
        return (
          <Card key={i.id}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ flex: 1, fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>Invoice #{i.invoiceNumber}</Text>
              <View style={{ backgroundColor: tone.bg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 11.5, color: tone.fg }}>{i.label}</Text>
              </View>
            </View>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 2 }}>
              {period
                ? `Hourly, ${i.periodFrom === i.periodTo ? shortDate(i.periodFrom) : `${shortDate(i.periodFrom)} to ${shortDate(i.periodTo)}`}`
                : i.title}
            </Text>
            <View style={{ marginTop: 8 }}>
              <Line left={i.gstRegistered ? "Total incl GST" : "Total"} right={dollars(i.total)} strong />
              {i.issuedOn ? <Line left="Issued" right={shortDate(i.issuedOn)} muted /> : null}
              {i.dueDate ? <Line left="Due" right={shortDate(i.dueDate)} muted /> : null}
              {i.state === "part_paid" ? (
                <>
                  <Line left="Paid so far" right={dollars(i.paid)} />
                  <Line left="Left to pay" right={dollars(i.balance)} />
                </>
              ) : null}
            </View>
            {period && !i.emailedToTerra ? (
              <Note tone="warn" text={`Not sent to Terra yet${i.emailError ? ` (${i.emailError})` : ""}. Tap Send again.`} />
            ) : null}
            {msg && msg.id === i.id ? <Note tone={msg.tone} text={msg.text} /> : null}
            {period ? (
              <View style={{ flexDirection: "row", gap: 8, marginTop: 10 }}>
                <Button label="PDF" tone="plain" icon="document-outline" disabled={!i.hasPdf} busy={busy === `pdf-${i.id}`} onPress={() => void openPdf(i.id)} />
                <Button label="Send again" tone="plain" icon="send-outline" busy={busy === `send-${i.id}`} onPress={() => void sendAgain(i.id)} />
              </View>
            ) : null}
          </Card>
        );
      })}
      <Note text="Paid and Part paid show once Terra office records the payment." />
    </View>
  );
}

/* ------------------------------ the screen ------------------------------ */

export default function HoursScreen() {
  const router = useRouter();
  const bottomInset = useBottomInset();
  const [tab, setTab] = useState<Tab>("time");
  const summary = useMyInvoiceSummary();
  const hourly = useMyHourlySummary();
  const jobs = useMyHourlyJobs();
  const invoices = useMyPeriodInvoices();
  const open = hourly.data?.open ?? null;
  useClockOutReminder(hourly.data ? (open ? { id: open.id, start: open.start } : null) : undefined);
  const s = summary.data;
  const refreshing = (summary.isFetching || hourly.isFetching) && !summary.isLoading;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 }}>
        <Pressable onPress={() => router.back()} style={{ padding: 4 }} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={c.foreground} />
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>My hours & invoices</Text>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 40 + bottomInset }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.primary}
            onRefresh={() => {
              void summary.refetch();
              void hourly.refetch();
              void jobs.refetch();
              void invoices.refetch();
            }}
          />
        }
      >
        {s ? (
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Tile label="AWAITING APPROVAL" value={String(s.awaitingApproval.entries)} hint={s.awaitingApproval.entries === 1 ? "entry" : "entries"} />
              <Tile label="READY TO INVOICE" value={dollars(s.readyToInvoice.amount)} hint={`${s.readyToInvoice.hours} h`} />
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Tile label="AWAITING PAYMENT" value={dollars(s.awaitingPayment.amount)} />
              <Tile label="PAID" value={dollars(s.paid.amount)} />
            </View>
          </View>
        ) : summary.isLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 12 }} />
        ) : null}

        <View style={{ flexDirection: "row", backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 12, padding: 3, marginTop: 14 }}>
          {(
            [
              ["time", "My time"],
              ["invoice", "Create invoice"],
              ["invoices", "My invoices"],
            ] as const
          ).map(([k, label]) => (
            <Pressable
              key={k}
              onPress={() => setTab(k)}
              style={{ flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: "center", backgroundColor: tab === k ? c.sidebar : "transparent" }}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: tab === k ? "#FFFFFF" : c.mutedForeground }}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {tab === "time" ? <MyTime openTaskId={open?.taskId ?? null} /> : null}
        {tab === "invoice" ? <CreateInvoice onIssued={() => setTab("invoices")} /> : null}
        {tab === "invoices" ? <MyInvoices /> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
