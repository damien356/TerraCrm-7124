import { useMemo } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { Colors, Fonts } from "@/constants/theme";
import { fmtLongDate, fmtMoney, fmtTime, statusLabel, todayISO } from "@/lib/format";
import { useLiveCrew, useOfficeSummary } from "@/queries/office";
import { useWhoami } from "@/queries/session";

const c = Colors.light;

function Stat({ label, value, hint, dark }: { label: string; value: string; hint?: string; dark?: boolean }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: dark ? c.sidebar : c.card,
        borderWidth: dark ? 0 : 1,
        borderColor: c.border,
        borderRadius: 14,
        padding: 13,
      }}
    >
      <Text
        style={{
          fontFamily: Fonts.medium,
          fontSize: 10,
          letterSpacing: 1,
          color: dark ? "rgba(255,255,255,0.5)" : c.mutedForeground,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: Fonts.bold,
          fontSize: 21,
          color: dark ? "#FFFFFF" : c.foreground,
          marginTop: 4,
        }}
      >
        {value}
      </Text>
      {hint ? (
        <Text
          style={{
            fontFamily: Fonts.sans,
            fontSize: 11.5,
            color: dark ? "rgba(255,255,255,0.6)" : c.mutedForeground,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground }}>{title}</Text>
        {count != null && count > 0 ? (
          <View
            style={{
              minWidth: 20,
              paddingHorizontal: 6,
              height: 20,
              borderRadius: 10,
              backgroundColor: c.muted,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 11, color: c.mutedForeground }}>{count}</Text>
          </View>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function Row({
  title,
  subtitle,
  right,
  tone,
  onPress,
  icon,
}: {
  title: string;
  subtitle?: string;
  right?: string;
  tone?: "warn" | "bad";
  onPress?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const edge = tone === "bad" ? c.destructive : tone === "warn" ? c.warning : c.border;
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderLeftWidth: tone ? 3 : 1,
        borderLeftColor: edge,
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      {icon ? <Ionicons name={icon} size={18} color={tone ? edge : c.mutedForeground} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? (
        <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.mutedForeground }}>{right}</Text>
      ) : null}
    </Pressable>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <View
      style={{
        backgroundColor: c.muted,
        borderRadius: 12,
        padding: 14,
      }}
    >
      <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}>{text}</Text>
    </View>
  );
}

/** The one thing the office does from a site visit: talk, and get a priced draft. */
function VoiceQuoteButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel="Record a voice quote"
      style={({ pressed }) => ({
        marginTop: 16,
        backgroundColor: c.primary,
        borderRadius: 18,
        paddingVertical: 18,
        paddingHorizontal: 18,
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        opacity: pressed ? 0.88 : 1,
      })}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: "rgba(255,255,255,0.18)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="mic" size={27} color="#FFFFFF" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: "#FFFFFF" }}>Voice quote</Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: "rgba(255,255,255,0.8)", marginTop: 1 }}>
          Talk through the job, get a priced draft
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,0.85)" />
    </Pressable>
  );
}

export default function OfficeScreen() {
  const router = useRouter();
  const who = useWhoami();
  const isAdmin = who.data?.canSeeOffice === true;
  const summary = useOfficeSummary(isAdmin);
  const crew = useLiveCrew(isAdmin);

  const data = summary.data;
  const onSite = useMemo(
    () => (data?.todayTasks ?? []).filter((t) => t.status === "in_progress").length,
    [data?.todayTasks],
  );

  if (who.isLoading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={c.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!isAdmin) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Ionicons name="lock-closed-outline" size={26} color={c.mutedForeground} />
          <Text
            style={{
              fontFamily: Fonts.sans,
              fontSize: 14,
              color: c.mutedForeground,
              textAlign: "center",
              marginTop: 10,
            }}
          >
            This screen is for the office. Your login is set up as crew.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={summary.isFetching && !summary.isLoading}
            onRefresh={() => {
              void summary.refetch();
              void crew.refetch();
            }}
            tintColor={c.primary}
          />
        }
      >
        <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, letterSpacing: 1, color: c.mutedForeground }}>
          {fmtLongDate(todayISO()).toUpperCase()}
        </Text>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 26, color: c.foreground, marginTop: 4 }}>
          The office
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, marginTop: 2 }}>
          {who.data?.name ? `${who.data.name}, ` : ""}admin access
        </Text>

        <VoiceQuoteButton onPress={() => router.push("/voice-quote")} />

        {summary.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <ActivityIndicator color={c.primary} />
          </View>
        ) : summary.isError ? (
          <View style={{ marginTop: 18 }}>
            <Empty text="Could not load the office screen. Pull down to try again." />
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
              <Stat
                dark
                label="ON TODAY"
                value={String(data?.todayTasks.length ?? 0)}
                hint={`${onSite} on site now`}
              />
              <Stat
                label="NOT COVERED"
                value={String(data?.unfilled.length ?? 0)}
                hint="next 7 days"
              />
            </View>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 10 }}>
              <Stat label="OPEN JOBS" value={String(data?.counts.openJobs ?? 0)} hint={`${data?.counts.leads ?? 0} leads`} />
              <Stat label="LAST 30 DAYS" value={fmtMoney(data?.pipelineValue ?? 0)} hint="job value in" />
            </View>

            <Section title="On site now" count={crew.data?.length ?? 0}>
              {(crew.data ?? []).length === 0 ? (
                <Empty text="Nobody is sharing a position right now. Pins only drop while a task is running." />
              ) : (
                (crew.data ?? []).map((p) => (
                  <Row
                    key={p.installerId}
                    icon="location"
                    title={p.installerName}
                    subtitle={p.taskTitle ?? "On the clock"}
                    right="Map"
                    onPress={() => {
                      const q = `${p.lat},${p.lng}`;
                      const url =
                        Platform.OS === "ios"
                          ? `http://maps.apple.com/?ll=${q}`
                          : `https://www.google.com/maps/search/?api=1&query=${q}`;
                      void Linking.openURL(url);
                    }}
                  />
                ))
              )}
            </Section>

            <Section title="Today's run" count={data?.todayTasks.length ?? 0}>
              {(data?.todayTasks ?? []).length === 0 ? (
                <Empty text="Nothing booked for today." />
              ) : (
                (data?.todayTasks ?? []).map((t) => (
                  <Row
                    key={t.id}
                    icon={t.status === "complete" ? "checkmark-circle" : "hammer-outline"}
                    title={t.title}
                    subtitle={`${t.installerName ?? "Nobody assigned"}${t.siteSuburb ? `, ${t.siteSuburb}` : ""}`}
                    right={t.startTime ? fmtTime(t.startTime) : statusLabel(t.status)}
                    tone={!t.installerName ? "bad" : undefined}
                  />
                ))
              )}
            </Section>

            <Section title="Needs covering" count={data?.unfilled.length ?? 0}>
              {(data?.unfilled ?? []).length === 0 ? (
                <Empty text="Everything in the next week has a name on it." />
              ) : (
                (data?.unfilled ?? []).map((t) => (
                  <Row
                    key={t.id}
                    icon="alert-circle-outline"
                    title={t.title}
                    subtitle={`${t.skillName ?? "No skill set"}${t.siteSuburb ? `, ${t.siteSuburb}` : ""}`}
                    right={t.scheduledDate ?? "No date"}
                    tone="warn"
                  />
                ))
              )}
            </Section>

            <Section title="Offers out" count={data?.pendingOffers.length ?? 0}>
              {(data?.pendingOffers ?? []).length === 0 ? (
                <Empty text="No offers waiting on a reply." />
              ) : (
                (data?.pendingOffers ?? []).map((o) => (
                  <Row
                    key={o.id}
                    icon="paper-plane-outline"
                    title={o.taskTitle}
                    subtitle={`${o.installerName}, ${o.mode === "broadcast" ? "broadcast" : "direct"}`}
                    right={o.payAmount ? fmtMoney(o.payAmount) : undefined}
                  />
                ))
              )}
            </Section>

            <Section title="Running late" count={data?.atRisk.length ?? 0}>
              {(data?.atRisk ?? []).length === 0 ? (
                <Empty text="Nothing has been left open past its day." />
              ) : (
                (data?.atRisk ?? []).map((t) => (
                  <Row
                    key={t.id}
                    icon="time-outline"
                    title={t.title}
                    subtitle={`${t.installerName ?? "Nobody assigned"}, ${statusLabel(t.status)}`}
                    right={t.scheduledDate ?? undefined}
                    tone="bad"
                  />
                ))
              )}
            </Section>

            <Section title="Latest activity">
              {(data?.recent ?? []).length === 0 ? (
                <Empty text="Nothing logged yet today." />
              ) : (
                (data?.recent ?? []).slice(0, 10).map((a) => (
                  <Row key={a.id} icon="ellipse-outline" title={a.detail} subtitle={a.actorName || undefined} />
                ))
              )}
            </Section>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
