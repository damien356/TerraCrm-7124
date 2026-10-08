import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomInset } from "@/hooks/use-bottom-gap";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors, Fonts, tintFor } from "@/constants/theme";
import { fmtMoney2, unitLabel } from "@/lib/format";
import { useMyRates } from "@/queries/rates";

const c = Colors.light;

const GROUP_LABEL: Record<string, string> = {
  carpet: "Carpet",
  resilient: "Resilient",
  timber: "Timber",
  prep: "Prep",
  demolition: "Demolition",
  trades: "Trades",
  surcharge: "Surcharges & allowances",
  other: "Other",
};

export default function RateCardScreen() {
  const bottomInset = useBottomInset();
  const router = useRouter();
  const myRates = useMyRates();
  const rows = myRates.data?.rates ?? [];

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = groups.get(r.groupName) ?? [];
    list.push(r);
    groups.set(r.groupName, list);
  }
  const groupOrder = ["carpet", "resilient", "timber", "prep", "demolition", "trades", "surcharge", "other"];
  const orderedGroups = groupOrder.filter((g) => groups.has(g));

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 12,
        }}
      >
        <Pressable onPress={() => router.back()} style={{ padding: 4 }}>
          <Ionicons name="chevron-back" size={24} color={c.foreground} />
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>Your rate card</Text>
      </View>

      {myRates.isLoading ? (
        <ActivityIndicator color={c.primary} style={{ marginTop: 32 }} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 40 + bottomInset }}>
          {myRates.data?.pendingChange ? (
            <View
              style={{
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.warning,
                borderRadius: 14,
                padding: 14,
                marginBottom: 16,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="alert-circle" size={18} color={c.warning} />
                <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>
                  New rates from {myRates.data.pendingChange.effectiveFrom}
                </Text>
              </View>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 6 }}>
                {myRates.data.pendingChange.changes.length} item
                {myRates.data.pendingChange.changes.length === 1 ? "" : "s"} changing. The office will confirm before
                it applies to a new job.
              </Text>
            </View>
          ) : null}

          {rows.length === 0 ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, marginTop: 8 }}>
              No rates set yet, the office prices your card against what you're ticked for.
            </Text>
          ) : (
            orderedGroups.map((g) => (
              <View key={g} style={{ marginBottom: 20 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <View style={{ width: 4, height: 16, borderRadius: 2, backgroundColor: tintFor(g).edge }} />
                  <Text
                    style={{
                      fontFamily: Fonts.medium,
                      fontSize: 11,
                      letterSpacing: 1,
                      color: c.mutedForeground,
                    }}
                  >
                    {(GROUP_LABEL[g] ?? g).toUpperCase()}
                  </Text>
                </View>
                {(groups.get(g) ?? []).map((r) => (
                  <View
                    key={r.itemId}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: c.card,
                      borderWidth: 1,
                      borderColor: c.border,
                      borderRadius: 12,
                      padding: 12,
                      marginBottom: 8,
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: 10 }}>
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>{r.name}</Text>
                      {r.minimumCharge != null ? (
                        <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground, marginTop: 2 }}>
                          Minimum {fmtMoney2(r.minimumCharge)}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: c.foreground }}>
                      {fmtMoney2(r.amount)}
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground }}>
                        {r.unit === "percent" ? "" : `/${unitLabel(r.unit)}`}
                      </Text>
                    </Text>
                  </View>
                ))}
              </View>
            ))
          )}

          <Text
            style={{
              fontFamily: Fonts.sans,
              fontSize: 12,
              color: c.mutedForeground,
              marginTop: 4,
              lineHeight: 17,
            }}
          >
            These are your own rates, ex GST. Only what you're ticked for shows here.
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
