import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Colors, Fonts } from "@/constants/theme";
import { fmtDayLabel, fmtMoney2, unitLabel } from "@/lib/format";
import { useCrewStages } from "@/queries/stages";

const c = Colors.light;

/* Staged jobs (Damien, 12 Nov 2026). Shown on a task done in parts. His pay only. */

const STATE_TEXT: Record<string, { text: string; bg: string; fg: string }> = {
  to_do: { text: "To do", bg: "#EEEDEA", fg: "#55524C" },
  awaiting_approval: { text: "Finished, awaiting office approval", bg: "#FBEDD8", fg: "#8A5A11" },
  claimable: { text: "Approved, ready to claim", bg: "#E4F0E2", fg: "#2F5F2B" },
  claimed: { text: "Claimed", bg: "#E3ECF5", fg: "#2D5A86" },
  timesheets: { text: "Paid from your approved timesheets", bg: "#E3ECF5", fg: "#2D5A86" },
};

export function StagePaySection({ taskId, gstRegistered }: { taskId: number; gstRegistered: boolean }) {
  const q = useCrewStages(taskId);
  const router = useRouter();
  const v = q.data;
  if (!v) return null;
  const gst = gstRegistered ? " +GST" : "";
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground }}>THIS JOB IS DONE IN STAGES</Text>
      <View style={{ marginTop: 9, backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14, gap: 12 }}>
        {v.stages.map((s) => {
          const tone = STATE_TEXT[s.state] ?? STATE_TEXT.to_do!;
          return (
            <View key={s.seq} style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground, flex: 1 }}>{s.name}</Text>
                <View style={{ backgroundColor: tone.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Text style={{ fontFamily: Fonts.medium, fontSize: 11, color: tone.fg }}>
                    {tone.text}
                    {s.claimRef ? ` ${s.claimRef}` : ""}
                  </Text>
                </View>
              </View>
              {s.scope ? <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>{s.scope}</Text> : null}
              {s.status === "complete" && s.completedOn ? (
                <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>Finished {fmtDayLabel(s.completedOn)}</Text>
              ) : null}
              {s.notYours ? <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>Given to another installer.</Text> : null}
              {s.lines.map((l, i) => (
                <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.foreground, flex: 1, paddingRight: 8 }}>
                    {l.hourly
                      ? `About ${l.estimatedHours ?? 0} h (an estimate, not pay)`
                      : `${+l.qty.toFixed(4)} ${unitLabel(l.unit)}${l.rate != null ? ` @ ${fmtMoney2(l.rate)}/${unitLabel(l.unit)}` : ""}`}
                  </Text>
                  {l.hourly ? null : (
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.foreground }}>
                      {fmtMoney2(l.amount)}
                      {gst}
                    </Text>
                  )}
                </View>
              ))}
            </View>
          );
        })}
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10, gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>You can claim now</Text>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: c.primary }}>
              {fmtMoney2(v.claimable)}
              {gst}
            </Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}>Pay for the remaining work</Text>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.foreground }}>
              {fmtMoney2(v.remainingPay)}
              {gst}
            </Text>
          </View>
          {v.returnVisit ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.foreground, marginTop: 4 }}>
              Return visit ({v.returnVisit.stageName}): {v.returnVisit.booked ? `Booked for ${fmtDayLabel(v.returnVisit.booked)}` : v.returnVisit.expected ? `Expected ${fmtDayLabel(v.returnVisit.expected)}, not booked yet. Terra office will book it with you.` : "Awaiting the site. Terra office will book the return visit when it is ready."}
            </Text>
          ) : null}
          {v.materialsLocation ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>Remaining material: {v.materialsLocation}</Text>
          ) : null}
          {v.claimable > 0 ? (
            <Pressable
              onPress={() => router.push(`/task/invoice/${taskId}`)}
              style={({ pressed }) => ({ backgroundColor: c.primary, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 6, opacity: pressed ? 0.85 : 1 })}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.primaryForeground }}>Claim the approved stage</Text>
            </Pressable>
          ) : null}
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
            A finished stage can be claimed once Terra office approves it. The remaining work is claimed when it is done.
          </Text>
        </View>
      </View>
    </View>
  );
}
