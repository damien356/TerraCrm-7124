import { useMemo } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Colors, Fonts } from "@/constants/theme";
import { EmptyState, TaskCard, type FieldTask } from "@/components/task-card";
import { fmtDayLabel, fmtMoney } from "@/lib/format";
import { useUpcoming } from "@/queries/field";
import { fixedPay } from "@/lib/pay";

const c = Colors.light;

export default function ScheduleScreen() {
  const upcoming = useUpcoming();

  const groups = useMemo(() => {
    const byDate = new Map<string, FieldTask[]>();
    for (const task of upcoming.data ?? []) {
      const key = task.scheduledDate ?? "unbooked";
      const list = byDate.get(key) ?? [];
      list.push(task);
      byDate.set(key, list);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [upcoming.data]);

  // One card per day on site, but each job is counted once (notes 18.61).
  const total = fixedPay(upcoming.data ?? []);
  const jobCount = new Set((upcoming.data ?? []).map((t) => t.id)).size;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={upcoming.isFetching && !upcoming.isLoading}
            onRefresh={() => void upcoming.refetch()}
            tintColor={c.primary}
          />
        }
      >
        <Text style={{ fontFamily: Fonts.bold, fontSize: 26, color: c.foreground }}>Coming up</Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 4 }}>
          Next four weeks. {jobCount} job{jobCount === 1 ? "" : "s"} booked,{" "}
          {fmtMoney(total)} in fixed-price work.
        </Text>

        {upcoming.isLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 32 }} />
        ) : upcoming.isError ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load your schedule"
            body="Pull down to try again."
          />
        ) : groups.length === 0 ? (
          <EmptyState
            icon="calendar-outline"
            title="Nothing booked in yet"
            body="When the office books you in or you accept an offer, it lands here."
          />
        ) : (
          groups.map(([date, tasks]) => (
            <View key={date} style={{ marginTop: 24 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>
                  {date === "unbooked" ? "Date to be confirmed" : fmtDayLabel(date)}
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
                <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: c.mutedForeground }}>
                  {tasks.length} job{tasks.length === 1 ? "" : "s"}
                </Text>
              </View>
              {tasks.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
