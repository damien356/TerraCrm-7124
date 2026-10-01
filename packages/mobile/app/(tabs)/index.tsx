import { useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts } from "@/constants/theme";
import { EmptyState, TaskCard, type FieldTask } from "@/components/task-card";
import { MonthGrid, ViewModeToggle, WeekStrip } from "@/components/calendar";
import { addDaysISO, fmtDayLabel, fmtLongDate, fmtMoney, startOfMonthISO, startOfWeekISO, todayISO } from "@/lib/format";
import { useMe, useOffers, useScheduleRange, useToday } from "@/queries/field";

const c = Colors.light;

type ViewMode = "day" | "week" | "month";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

export default function TodayScreen() {
  const me = useMe();
  const today = useToday();
  const offers = useOffers();

  const [viewMode, setViewMode] = useState<ViewMode>("day");
  const [selectedDate, setSelectedDate] = useState(todayISO());

  // Week strip spans the selected day's Mon-Sun. Month grid spans 6 whole
  // weeks around the selected day's month. Both are fetched from the same
  // field.upcoming feed, just widened for the view that's showing.
  const weekStart = startOfWeekISO(selectedDate);
  const weekEnd = addDaysISO(weekStart, 6);
  const monthAnchor = startOfMonthISO(selectedDate);
  const gridStart = startOfWeekISO(monthAnchor);
  const gridEnd = addDaysISO(gridStart, 41);

  const weekRange = useScheduleRange(weekStart, weekEnd);
  const monthRange = useScheduleRange(gridStart, gridEnd);

  const rangeTasks = viewMode === "month" ? monthRange.data : viewMode === "week" ? weekRange.data : null;
  const countsByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of rangeTasks ?? []) {
      if (!t.scheduledDate) continue;
      map.set(t.scheduledDate, (map.get(t.scheduledDate) ?? 0) + 1);
    }
    return map;
  }, [rangeTasks]);

  const isToday = selectedDate === todayISO();
  /* The list is always one day's work: today's own feed on the day view, and
   * the selected day's slice of the range on the week and month views. */
  const tasks = useMemo<FieldTask[]>(() => {
    if (viewMode === "day" || isToday) return today.data ?? [];
    return (rangeTasks ?? []).filter((t) => t.scheduledDate === selectedDate);
  }, [viewMode, isToday, today.data, rangeTasks, selectedDate]);

  const dayPay = useMemo(
    () => tasks.reduce((sum, t) => sum + (t.payType === "per_job" ? (t.payAmount ?? 0) : 0), 0),
    [tasks],
  );
  const outstanding = tasks.filter((t) => t.status !== "complete").length;
  const firstName = (me.data?.name ?? "").split(" ")[0];

  const loading = viewMode === "month" ? monthRange.isLoading : viewMode === "week" ? weekRange.isLoading : today.isLoading;
  const isError = viewMode === "month" ? monthRange.isError : viewMode === "week" ? weekRange.isError : today.isError;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={today.isFetching && !today.isLoading}
            onRefresh={() => {
              void today.refetch();
              void offers.refetch();
              void weekRange.refetch();
              void monthRange.refetch();
            }}
            tintColor={c.primary}
          />
        }
      >
        <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, letterSpacing: 1, color: c.mutedForeground }}>
          {fmtLongDate(todayISO()).toUpperCase()}
        </Text>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 26, color: c.foreground, marginTop: 4 }}>
          {greeting()}
          {firstName ? `, ${firstName}` : ""}
        </Text>

        <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
          <View
            style={{
              flex: 1,
              backgroundColor: c.sidebar,
              borderRadius: 14,
              padding: 14,
            }}
          >
            <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: "rgba(255,255,255,0.5)" }}>
              {viewMode === "day" ? "JOBS TODAY" : "JOBS THIS DAY"}
            </Text>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: "#FFFFFF", marginTop: 4 }}>
              {tasks.length}
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: "rgba(255,255,255,0.6)" }}>
              {outstanding === 0 && tasks.length > 0 ? "All done" : `${outstanding} to go`}
            </Text>
          </View>
          <View
            style={{
              flex: 1,
              backgroundColor: c.card,
              borderRadius: 14,
              padding: 14,
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
              YOUR PAY
            </Text>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground, marginTop: 4 }}>
              {fmtMoney(dayPay)}
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>fixed-price work</Text>
          </View>
        </View>

        {(offers.data?.length ?? 0) > 0 ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              backgroundColor: "#FBEDD8",
              borderRadius: 12,
              padding: 12,
              marginTop: 12,
            }}
          >
            <Ionicons name="notifications" size={18} color="#8A5A11" />
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#8A5A11", flex: 1 }}>
              {offers.data?.length} job{(offers.data?.length ?? 0) > 1 ? "s" : ""} waiting on your answer. Check the
              Offers tab.
            </Text>
          </View>
        ) : null}

        <View style={{ marginTop: 20 }}>
          <ViewModeToggle
            value={viewMode}
            onChange={(v) => {
              setViewMode(v);
              if (v === "day") setSelectedDate(todayISO());
            }}
          />
        </View>

        {viewMode === "week" ? (
          <View style={{ marginTop: 16 }}>
            <WeekStrip
              weekStart={weekStart}
              selected={selectedDate}
              onSelect={setSelectedDate}
              countsByDate={countsByDate}
            />
          </View>
        ) : viewMode === "month" ? (
          <View style={{ marginTop: 16 }}>
            <MonthGrid
              anchor={monthAnchor}
              selected={selectedDate}
              onSelect={setSelectedDate}
              countsByDate={countsByDate}
            />
          </View>
        ) : null}

        <Text
          style={{
            fontFamily: Fonts.medium,
            fontSize: 11,
            letterSpacing: 1.2,
            color: c.mutedForeground,
            marginTop: 24,
            marginBottom: 10,
          }}
        >
          {viewMode === "day" ? "TODAY'S WORK" : fmtDayLabel(selectedDate).toUpperCase()}
        </Text>

        {loading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 24 }} />
        ) : isError ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load your day"
            body="Pull down to try again. If it keeps failing, give the office a call."
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon="cafe-outline"
            title={viewMode === "day" ? "Nothing booked today" : "Nothing booked this day"}
            body="Check the Coming up tab for the rest of the week, or the Offers tab for work up for grabs."
          />
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
