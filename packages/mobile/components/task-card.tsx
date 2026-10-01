import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors, Fonts, tintFor } from "@/constants/theme";
import { fmtHours, fmtMoney, fmtMoney2, fmtTime, statusLabel, unitLabel } from "@/lib/format";
import type { useToday } from "@/queries/field";

const c = Colors.light;

/** Exactly the shape the field API hands back — no customer pricing in it. */
export type FieldTask = NonNullable<ReturnType<typeof useToday>["data"]>[number];

function Chip({
  icon,
  label,
  tone = "muted",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  tone?: "muted" | "warn" | "good";
}) {
  const bg = tone === "warn" ? "#FBEDD8" : tone === "good" ? "#E4F0E2" : c.secondary;
  const fg = tone === "warn" ? "#8A5A11" : tone === "good" ? "#2F5F2B" : c.mutedForeground;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: bg,
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 7,
      }}
    >
      <Ionicons name={icon} size={13} color={fg} />
      <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: fg }}>{label}</Text>
    </View>
  );
}

export function TaskCard({
  task,
  showDay,
  showPay = true,
}: {
  task: FieldTask;
  showDay?: string;
  showPay?: boolean;
}) {
  const router = useRouter();
  const tint = tintFor(task.skillGroup);
  const done = task.status === "complete";
  const running = task.status === "in_progress";

  return (
    <Pressable
      onPress={() => router.push(`/task/${task.id}`)}
      style={({ pressed }) => ({
        backgroundColor: c.card,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: running ? c.primary : c.border,
        overflow: "hidden",
        marginBottom: 12,
        opacity: pressed ? 0.9 : done ? 0.66 : 1,
      })}
    >
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: 6, backgroundColor: tint.edge }} />
        <View style={{ flex: 1, padding: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
              <View
                style={{
                  backgroundColor: tint.fill,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  borderRadius: 6,
                }}
              >
                <Text style={{ fontFamily: Fonts.bold, fontSize: 11, color: tint.edge }}>
                  {task.skillName ?? "Work"}
                </Text>
              </View>
              <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: c.mutedForeground }}>
                Job #{task.jobNumber}
              </Text>
            </View>
            {running ? (
              <Text style={{ fontFamily: Fonts.bold, fontSize: 11, color: c.primary }}>ON THE JOB</Text>
            ) : done ? (
              <Ionicons name="checkmark-circle" size={18} color={c.success} />
            ) : (
              <Ionicons name="chevron-forward" size={18} color={c.mutedForeground} />
            )}
          </View>

          <Text
            style={{
              fontFamily: Fonts.bold,
              fontSize: 17,
              color: c.foreground,
              marginTop: 9,
              lineHeight: 22,
            }}
          >
            {task.title}
          </Text>

          <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, marginTop: 3 }}>
            {[task.siteAddress, task.siteSuburb].filter(Boolean).join(", ") || "Address to come"}
          </Text>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 11 }}>
            {showDay ? <Chip icon="calendar-outline" label={showDay} /> : null}
            <Chip icon="time-outline" label={`${fmtTime(task.startTime)} · ${fmtHours(task.durationHours)}`} />
            {task.crewSize > 1 ? <Chip icon="people-outline" label="2 on site" /> : null}
            {task.isSecond ? <Chip icon="person-add-outline" label="You're 2nd man" /> : null}
            {task.furnitureOnSite ? <Chip icon="bed-outline" label="Furniture on site" tone="warn" /> : null}
            {done ? <Chip icon="checkmark-done-outline" label={statusLabel(task.status)} tone="good" /> : null}
          </View>

          {showPay ? (
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: c.border,
                marginTop: 12,
                paddingTop: 10,
              }}
            >
              <Text
                style={{
                  fontFamily: Fonts.medium,
                  fontSize: 10.5,
                  letterSpacing: 1,
                  color: c.mutedForeground,
                }}
              >
                YOUR PAY
              </Text>

              {task.payBreakdown && task.payBreakdown.length > 0 ? (
                <View style={{ marginTop: 6 }}>
                  {task.payBreakdown.map((line, idx) => (
                    <View
                      key={idx}
                      style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 }}
                    >
                      <Text
                        style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, flex: 1, paddingRight: 8 }}
                      >
                        {line.name}
                        <Text style={{ color: c.mutedForeground }}>
                          {" "}
                          · {line.qty} {unitLabel(line.unit)}
                        </Text>
                      </Text>
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.foreground }}>
                        {line.total != null ? fmtMoney2(line.total) : "-"}
                      </Text>
                    </View>
                  ))}
                  <View
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      borderTopWidth: 1,
                      borderTopColor: c.border,
                      marginTop: 6,
                      paddingTop: 6,
                    }}
                  >
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>Total</Text>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: c.foreground }}>
                      {fmtMoney(task.payAmount)}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View />
                  <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: c.foreground }}>
                    {fmtMoney(task.payAmount)}
                    {task.payType === "hourly" ? (
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}> /hr</Text>
                    ) : task.payType === "per_m2" ? (
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}> /m²</Text>
                    ) : null}
                  </Text>
                </View>
              )}
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export function EmptyState({
  icon,
  title,
  body,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
}) {
  return (
    <View style={{ alignItems: "center", paddingVertical: 56, paddingHorizontal: 32 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          backgroundColor: c.secondary,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={26} color={c.mutedForeground} />
      </View>
      <Text style={{ fontFamily: Fonts.bold, fontSize: 17, color: c.foreground, marginTop: 16 }}>{title}</Text>
      <Text
        style={{
          fontFamily: Fonts.sans,
          fontSize: 14,
          color: c.mutedForeground,
          marginTop: 6,
          textAlign: "center",
          lineHeight: 20,
        }}
      >
        {body}
      </Text>
    </View>
  );
}
