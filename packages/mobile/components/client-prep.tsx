import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts } from "@/constants/theme";
import { useFieldOnMyWay, useFieldTickApt } from "@/queries/field";

const c = Colors.light;

const APT_CHECKS = [
  ["fire", "Fire alarm isolated"],
  ["lift", "Lift booked and padded"],
  ["parking", "Parking/access sorted"],
] as const;

type AptKey = (typeof APT_CHECKS)[number][0];
type AptChecks = Partial<Record<AptKey, { at: string; by: string }>>;

/**
 * CLIENT PREP on the job screen (notes 18.56). On my way texts the client,
 * once a day. Units and apartments also get the three checks before work
 * starts. Shown only while the task is live.
 */
export function ClientPrepCard({
  taskId,
  live,
  unit,
  aptChecks,
}: {
  taskId: number;
  live: boolean;
  unit?: boolean;
  aptChecks?: AptChecks | null;
}) {
  const omw = useFieldOnMyWay();
  const tick = useFieldTickApt();
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  if (!live) return null;
  const checks = aptChecks ?? {};

  async function onMyWay() {
    setNote(null);
    try {
      const r = await omw.mutateAsync({ taskId });
      setNote({ tone: "ok", text: r.message });
    } catch (e) {
      setNote({ tone: "warn", text: e instanceof Error ? e.message : "Not sent. Call the client." });
    }
  }

  async function toggle(key: AptKey) {
    setNote(null);
    try {
      await tick.mutateAsync({ taskId, key, done: !checks[key] });
    } catch (e) {
      setNote({ tone: "warn", text: e instanceof Error ? e.message : "Couldn't save that. Try again with signal." });
    }
  }

  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground }}>CLIENT</Text>
      <View style={{ backgroundColor: c.card, borderWidth: 1, borderColor: c.border, borderRadius: 14, padding: 14, marginTop: 9 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => (omw.isPending ? undefined : void onMyWay())}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            backgroundColor: c.primary,
            borderRadius: 10,
            paddingVertical: 12,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          {omw.isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="car-outline" size={18} color="#FFFFFF" />
              <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: "#FFFFFF" }}>On my way</Text>
            </>
          )}
        </Pressable>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 6, textAlign: "center" }}>
          Texts the client that you are on the way.
        </Text>

        {unit ? (
          <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 12, paddingTop: 10 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>Unit checklist</Text>
            {APT_CHECKS.map(([key, label]) => {
              const done = !!checks[key];
              return (
                <Pressable
                  key={key}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: done }}
                  onPress={() => (tick.isPending ? undefined : void toggle(key))}
                  style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, opacity: pressed ? 0.7 : 1 })}
                >
                  <Ionicons name={done ? "checkbox" : "square-outline"} size={22} color={done ? c.success : c.mutedForeground} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>{label}</Text>
                    {done && checks[key]?.by ? (
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground }}>Ticked by {checks[key]!.by}</Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ) : null}

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
