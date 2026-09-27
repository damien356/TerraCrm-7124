import { useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts, tintFor } from "@/constants/theme";
import { authClient } from "@/lib/auth";
import { crewLabel, daysUntil, fmtDateTime, fmtDayLabel, fmtMoney } from "@/lib/format";
import { useHistory, useMe, useSetLocationConsent } from "@/queries/field";
import { currentUpdate, updatesSupported } from "@/lib/updates";
import appJson from "@/app.json";

const c = Colors.light;

/** One line naming the exact build, so a support call can start with facts. */
function buildLine() {
  const version = appJson.expo.version;
  if (!updatesSupported) return `Terra ${version}`;
  const u = currentUpdate();
  const build = u.isEmbedded ? "store build" : `update ${(u.updateId ?? "").slice(0, 8)}`;
  return `Terra ${version} · ${u.channel} · ${build}`;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        padding: 13,
      }}
    >
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}>
        {label}
      </Text>
      <Text style={{ fontFamily: Fonts.bold, fontSize: 20, color: c.foreground, marginTop: 4 }}>{value}</Text>
      {hint ? (
        <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground }}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** Insurance / licence expiry warning — his rule: flag it before it lapses. */
function ExpiryRow({ label, value }: { label: string; value: Date | string | null | undefined }) {
  const days = daysUntil(value);
  if (!value) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
        <Ionicons name="alert-circle-outline" size={16} color={c.warning} />
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground }}>
          {label}: not on file — send it to the office.
        </Text>
      </View>
    );
  }
  const expired = (days ?? 0) < 0;
  const soon = (days ?? 0) >= 0 && (days ?? 0) <= 30;
  const colour = expired ? c.destructive : soon ? c.warning : c.mutedForeground;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
      <Ionicons
        name={expired || soon ? "alert-circle" : "shield-checkmark-outline"}
        size={16}
        color={expired || soon ? colour : c.success}
      />
      <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: colour }}>
        {label}: {fmtDateTime(value)}
        {expired ? " — expired" : soon ? ` — ${days} days left` : ""}
      </Text>
    </View>
  );
}

export default function MeScreen() {
  const [skillsOpen, setSkillsOpen] = useState(false);
  const me = useMe();
  const history = useHistory();
  const setConsent = useSetLocationConsent();
  const sharingOn = Boolean(me.data?.locationConsentAt);

  const skills = me.data?.skills ?? [];
  const jobs = history.data ?? [];
  const earnedAll = jobs.reduce((sum, j) => sum + (j.payAmount ?? 0), 0);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={me.isFetching && !me.isLoading}
            onRefresh={() => {
              void me.refetch();
              void history.refetch();
            }}
            tintColor={c.primary}
          />
        }
      >
        {me.isLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 32 }} />
        ) : (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 13 }}>
              <View
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: 27,
                  backgroundColor: c.sidebar,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ fontFamily: Fonts.bold, fontSize: 20, color: "#FFFFFF" }}>
                  {(me.data?.name ?? "?")
                    .split(" ")
                    .map((p) => p[0])
                    .slice(0, 2)
                    .join("")}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: Fonts.bold, fontSize: 21, color: c.foreground }}>
                  {me.data?.name ?? "Installer"}
                </Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground }}>
                  {me.data?.mobile ?? me.data?.email ?? ""}
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
              <Tile label="FINISHED" value={String(me.data?.stats.completed ?? 0)} hint="jobs all up" />
              <Tile label="BOOKED IN" value={String(me.data?.stats.upcoming ?? 0)} hint="still to do" />
              <Tile label="EARNED" value={fmtMoney(me.data?.stats.earned ?? 0)} hint="on finished work" />
            </View>

            <View
              style={{
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 14,
                padding: 14,
                marginTop: 12,
              }}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
                YOUR DETAILS
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
                <Ionicons name="people-outline" size={16} color={c.mutedForeground} />
                <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.foreground }}>
                  {crewLabel(me.data?.crewCapacity)}
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
                <Ionicons name="map-outline" size={16} color={c.mutedForeground} />
                <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.foreground }}>
                  {me.data?.serviceArea || "No set area"}
                </Text>
              </View>
              <ExpiryRow label="Insurance" value={me.data?.insuranceExpiry} />
              <ExpiryRow label="Licence" value={me.data?.licenceExpiry} />
            </View>

            <View
              style={{
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: sharingOn ? c.primary : c.border,
                borderRadius: 14,
                padding: 14,
                marginTop: 12,
              }}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
                LOCATION SHARING
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 }}>
                <Ionicons
                  name={sharingOn ? "navigate-circle" : "navigate-circle-outline"}
                  size={20}
                  color={sharingOn ? c.primary : c.mutedForeground}
                />
                <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: c.foreground, flex: 1 }}>
                  {sharingOn ? "On while a job is running" : "Off"}
                </Text>
                <Pressable
                  onPress={() => {
                    if (setConsent.isPending) return;
                    void setConsent.mutateAsync({ on: !sharingOn });
                  }}
                  style={{
                    backgroundColor: sharingOn ? c.secondary : c.primary,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 9,
                  }}
                >
                  <Text
                    style={{
                      fontFamily: Fonts.bold,
                      fontSize: 12.5,
                      color: sharingOn ? c.foreground : "#FFFFFF",
                    }}
                  >
                    {setConsent.isPending ? "..." : sharingOn ? "Switch off" : "Switch on"}
                  </Text>
                </Pressable>
              </View>
              <Text
                style={{
                  fontFamily: Fonts.sans,
                  fontSize: 12.5,
                  lineHeight: 18,
                  color: c.mutedForeground,
                  marginTop: 10,
                }}
              >
                Your position only goes to the office between you hitting Start job and marking it complete. Nothing is
                sent before, after, or on your days off. Switch it off and your whole location history is deleted on the
                spot. It stays your call — the office can't switch it on for you.
              </Text>
            </View>

            <Pressable
              onPress={() => setSkillsOpen((v) => !v)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                marginTop: 24,
                marginBottom: skillsOpen ? 10 : 0,
                paddingVertical: 4,
              }}
            >
              <Text
                style={{
                  fontFamily: Fonts.medium,
                  fontSize: 11,
                  letterSpacing: 1.2,
                  color: c.mutedForeground,
                  flex: 1,
                }}
              >
                WHAT YOU'RE TICKED FOR · {skills.length}
              </Text>
              <Ionicons name={skillsOpen ? "chevron-up" : "chevron-down"} size={16} color={c.mutedForeground} />
            </Pressable>
            {!skillsOpen ? null : skills.length === 0 ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground }}>
                Nothing ticked yet — the office sets your trades and rates.
              </Text>
            ) : (
              skills.map((s) => {
                const tint = tintFor(s.groupName);
                return (
                  <View
                    key={s.name}
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
                    <View style={{ width: 4, height: 30, borderRadius: 2, backgroundColor: tint.edge }} />
                    <View style={{ flex: 1, marginLeft: 11 }}>
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 14.5, color: c.foreground }}>{s.name}</Text>
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
                        {s.canLead ? "Can lead" : "Offsider"}
                      </Text>
                    </View>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: c.foreground }}>
                      {fmtMoney(s.rate)}
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground }}>
                        {s.rateType === "hourly" ? " /hr" : s.rateType === "per_m2" ? " /m²" : " /job"}
                      </Text>
                    </Text>
                  </View>
                );
              })
            )}

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
              FINISHED WORK · {fmtMoney(earnedAll)}
            </Text>
            {jobs.length === 0 ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground }}>
                Nothing finished yet.
              </Text>
            ) : (
              jobs.map((j) => (
                <View
                  key={j.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    borderBottomWidth: 1,
                    borderBottomColor: c.border,
                    paddingVertical: 11,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>{j.title}</Text>
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
                      #{j.jobNumber} · {j.siteSuburb ?? ""} · {fmtDayLabel(j.scheduledDate)}
                    </Text>
                  </View>
                  <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: c.foreground }}>
                    {fmtMoney(j.payAmount)}
                  </Text>
                </View>
              ))
            )}

            <Pressable
              onPress={() => void authClient.signOut()}
              style={({ pressed }) => ({
                marginTop: 28,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.destructive }}>Sign out</Text>
            </Pressable>

            {/* Which build this phone is on. Read it out when reporting a problem,
                and use it to confirm an update or a rollback actually landed. */}
            <Text
              style={{
                fontFamily: Fonts.sans,
                fontSize: 11,
                color: c.mutedForeground,
                textAlign: "center",
                marginTop: 16,
                marginBottom: 8,
              }}
            >
              {buildLine()}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
