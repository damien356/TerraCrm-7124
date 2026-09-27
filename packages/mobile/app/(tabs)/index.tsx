import { useMemo } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts } from "@/constants/theme";
import { EmptyState, TaskCard } from "@/components/task-card";
import { fmtLongDate, fmtMoney, todayISO } from "@/lib/format";
import { useMe, useOffers, useToday } from "@/queries/field";

const c = Colors.light;

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

  const tasks = today.data ?? [];
  const dayPay = useMemo(
    () =>
      (today.data ?? []).reduce(
        (sum, t) => sum + (t.payType === "per_job" ? (t.payAmount ?? 0) : 0),
        0,
      ),
    [today.data],
  );
  const outstanding = tasks.filter((t) => t.status !== "complete").length;
  const firstName = (me.data?.name ?? "").split(" ")[0];

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
              JOBS TODAY
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
              YOUR PAY TODAY
            </Text>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground, marginTop: 4 }}>
              {fmtMoney(dayPay)}
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
              fixed-price work
            </Text>
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
              {offers.data?.length} job{(offers.data?.length ?? 0) > 1 ? "s" : ""} waiting on your answer — check the
              Offers tab.
            </Text>
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
          TODAY'S WORK
        </Text>

        {today.isLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 24 }} />
        ) : today.isError ? (
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load your day"
            body="Pull down to try again. If it keeps failing, give the office a call."
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon="cafe-outline"
            title="Nothing booked today"
            body="Check the Coming up tab for the rest of the week, or the Offers tab for work up for grabs."
          />
        ) : (
          tasks.map((task) => <TaskCard key={task.id} task={task} />)
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
