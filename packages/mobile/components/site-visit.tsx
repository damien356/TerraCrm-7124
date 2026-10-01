import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts } from "@/constants/theme";
import { fmtDayLabel } from "@/lib/format";
import { useMyVisits, useTapArrived, useTapLeft } from "@/queries/crew";

const c = Colors.light;

function clock(iso: Date | string | null | undefined) {
  if (!iso) return "";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h < 12 ? "am" : "pm"}`;
}

/**
 * ON SITE, on the job screen. Arrived and Left site by hand, for anyone who
 * said no to Always location or whose phone missed the circle. Arriving only
 * stamps the time, it never starts the job. A red line shows any day left
 * without its completion photos, which the office also sees in red.
 */
export function SiteVisitCard({ taskId, live }: { taskId: number; live: boolean }) {
  const visits = useMyVisits(taskId, live);
  const arrive = useTapArrived();
  const leave = useTapLeft();
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  if (!live) return null;
  if (visits.isLoading) {
    return (
      <View style={{ marginTop: 14 }}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }
  if (visits.isError || !visits.data) return null;

  const { onSite, flaggedDates } = visits.data;
  const open = visits.data.visits.find((v) => !v.leftAt);
  const flaggedRows = visits.data.visits.filter((v) => v.flagged);
  const busy = arrive.isPending || leave.isPending;

  async function tap() {
    setNote(null);
    try {
      if (onSite) {
        const r = await leave.mutateAsync({ taskId, source: "manual" });
        if (r.outcome === "left" && r.flagged) {
          setNote({ tone: "warn", text: r.message ?? "Today's completion photos are still needed." });
        } else if (r.outcome === "not_here") {
          setNote({ tone: "ok", text: "You weren't marked on site." });
        } else {
          setNote({ tone: "ok", text: "Left site." });
        }
      } else {
        const r = await arrive.mutateAsync({ taskId, source: "manual" });
        if (r.outcome === "task_closed") setNote({ tone: "warn", text: r.message });
        else setNote({ tone: "ok", text: r.outcome === "already_here" ? "Already marked on site." : "Marked Arrived." });
      }
    } catch (e) {
      setNote({ tone: "warn", text: e instanceof Error ? e.message : "Couldn't save that. Try again with signal." });
    }
  }

  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground }}>ON SITE</Text>

      {flaggedDates.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            gap: 9,
            alignItems: "flex-start",
            backgroundColor: "#FBE3DF",
            borderWidth: 1,
            borderColor: c.destructive,
            borderRadius: 12,
            padding: 12,
            marginTop: 9,
          }}
        >
          <Ionicons name="camera" size={18} color="#8B2F22" style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: "#8B2F22" }}>Completion photos still needed</Text>
            {flaggedRows.map((v) => (
              <Text key={v.id} style={{ fontFamily: Fonts.sans, fontSize: 13, lineHeight: 18, color: "#8B2F22", marginTop: 3 }}>
                {fmtDayLabel(v.visitDate)}: {v.photosHad ?? 0} of {v.photosNeeded ?? 0} taken.
              </Text>
            ))}
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, lineHeight: 18, color: "#8B2F22", marginTop: 4 }}>
              The office sees this job in red until they're in. Add them under Completion photos below.
            </Text>
          </View>
        </View>
      ) : null}

      <View
        style={{
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: onSite ? c.primary : c.border,
          borderRadius: 14,
          padding: 14,
          marginTop: 9,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons name={onSite ? "location" : "location-outline"} size={20} color={onSite ? c.primary : c.mutedForeground} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>
              {onSite ? `On site since ${clock(open?.arrivedAt)}` : "Not marked on site"}
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
              {onSite
                ? open?.arriveSource === "geofence"
                  ? "Marked by location"
                  : "You tapped Arrived"
                : "Arriving only stamps the time. Start job is still your tap."}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => (busy ? undefined : void tap())}
            style={{
              backgroundColor: onSite ? c.secondary : c.primary,
              paddingHorizontal: 14,
              paddingVertical: 9,
              borderRadius: 9,
              minWidth: 92,
              alignItems: "center",
            }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={onSite ? c.foreground : "#FFFFFF"} />
            ) : (
              <Text style={{ fontFamily: Fonts.bold, fontSize: 13, color: onSite ? c.foreground : "#FFFFFF" }}>
                {onSite ? "Left site" : "Arrived"}
              </Text>
            )}
          </Pressable>
        </View>
        {note ? (
          <Text
            style={{
              fontFamily: Fonts.medium,
              fontSize: 12.5,
              lineHeight: 18,
              color: note.tone === "warn" ? c.destructive : c.success,
              marginTop: 10,
            }}
          >
            {note.text}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
