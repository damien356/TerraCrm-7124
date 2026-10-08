import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useBottomInset } from "@/hooks/use-bottom-gap";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts, tintFor } from "@/constants/theme";
import { EmptyState } from "@/components/task-card";
import { fmtCountdown, fmtDayLabel, fmtHours, fmtMoney, fmtTime } from "@/lib/format";
import { useAcceptOffer, useDeclineOffer, useOffers } from "@/queries/field";

const c = Colors.light;

/** Every day a task could land on. Empty when the office set one fixed day. */
function windowDays(from?: string | null, to?: string | null): string[] {
  if (!from) return [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to ?? from}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const out: string[] = [];
  for (const d = new Date(start); d <= end && out.length < 30; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Suburb and state, and never a bare "QLD" when the suburb is missing. */
function suburbLine(suburb?: string | null, state?: string | null) {
  const s = (suburb ?? "").trim();
  if (!s) return "Suburb on acceptance";
  return state ? `${s} ${state}` : s;
}

/** "Residential" / "Commercial", enough to picture the site and nothing more. */
function propertyLabel(type?: string | null) {
  if (!type) return "";
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, " ");
}

/**
 * The offer pay is always the total for the task, even when the office worked
 * it out off an hourly or per m² rate. This says which, so the number is never
 * misread as the rate itself.
 */
function payBasis(payType?: string | null, hours?: number | null) {
  switch (payType) {
    case "hourly":
      return hours ? `total, your hourly rate over ${fmtHours(hours)}` : "total, off your hourly rate";
    case "per_m2":
      return "total, off your m² rate";
    case "day_rate":
      return "total, off your day rate";
    default:
      return "fixed for the task";
  }
}

function holdClock(until?: Date | string | null) {
  if (!until) return "shortly";
  const d = typeof until === "string" ? new Date(until) : until;
  return d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

type Offer = NonNullable<ReturnType<typeof useOffers>["data"]>[number];

export default function OffersScreen() {
  const bottomInset = useBottomInset();
  const offers = useOffers();
  const accept = useAcceptOffer();
  const decline = useDeclineOffer();

  const [declining, setDeclining] = useState<Offer | null>(null);
  const [dayPick, setDayPick] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // Ticks the countdowns without hammering the API.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  async function onAccept(offer: Offer) {
    setError(null);
    const days = windowDays(offer.scheduledFrom, offer.scheduledTo);
    const chosen = dayPick[offer.offerId] ?? (days.length === 1 ? days[0] : undefined);
    if (days.length > 1 && !chosen) {
      setError("Pick which day you'll do it first.");
      return;
    }
    try {
      await accept.mutateAsync({ offerId: offer.offerId, chosenDate: chosen ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't take that job. Someone may have beaten you to it.");
    }
  }

  async function onDecline() {
    if (!declining) return;
    if (reason.trim().length < 3) {
      setError("Give the office a reason, even a few words.");
      return;
    }
    setError(null);
    try {
      await decline.mutateAsync({ offerId: declining.offerId, reason: reason.trim() });
      setDeclining(null);
      setReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    }
  }

  const list = offers.data ?? [];

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={offers.isFetching && !offers.isLoading}
            onRefresh={() => void offers.refetch()}
            tintColor={c.primary}
          />
        }
      >
        <Text style={{ fontFamily: Fonts.bold, fontSize: 26, color: c.foreground }}>Offers</Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 4, lineHeight: 20 }}>
          Work up for grabs. Offers sent to a few installers go to whoever says yes first, and they lapse after two
          hours. Where the office left the day open, you pick it.
        </Text>

        {error ? (
          <View style={{ backgroundColor: "#FBE3DF", borderRadius: 10, padding: 12, marginTop: 14 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: "#8B2F22" }}>{error}</Text>
          </View>
        ) : null}

        {offers.isLoading ? (
          <ActivityIndicator color={c.primary} style={{ marginTop: 32 }} />
        ) : offers.isError ? (
          <EmptyState icon="cloud-offline-outline" title="Couldn't load offers" body="Pull down to try again." />
        ) : list.length === 0 ? (
          <EmptyState
            icon="checkmark-done-outline"
            title="No offers right now"
            body="When the office sends work your way it shows up here and your phone buzzes."
          />
        ) : (
          list.map((offer) => {
            const tint = tintFor(offer.skillGroup);
            const holding = offer.status === "provisional";
            const days = windowDays(offer.scheduledFrom, offer.scheduledTo);
            const chosen = dayPick[offer.offerId] ?? (days.length === 1 ? days[0] : undefined);
            const countdown = fmtCountdown(offer.expiresAt, now);
            const urgent = countdown.includes("m left") && !countdown.includes("h");
            const busy =
              (accept.isPending && accept.variables?.offerId === offer.offerId) ||
              (decline.isPending && decline.variables?.offerId === offer.offerId);

            return (
              <View
                key={offer.offerId}
                style={{
                  backgroundColor: c.card,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: urgent ? c.warning : c.border,
                  marginTop: 14,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                    backgroundColor: tint.fill,
                    paddingHorizontal: 14,
                    paddingVertical: 9,
                  }}
                >
                  <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: tint.edge }}>
                    {offer.skillName ?? "Work"} · Job #{offer.jobNumber}
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <Ionicons name="hourglass-outline" size={13} color={tint.edge} />
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: tint.edge }}>{countdown}</Text>
                  </View>
                </View>

                <View style={{ padding: 14 }}>
                  <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.foreground, lineHeight: 23 }}>
                    {offer.title}
                  </Text>
                  {/* Suburb only while it's still an offer. Street address and the
                      site contact land on the task card once it's theirs. */}
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 }}>
                    <Ionicons name="location-outline" size={14} color={c.mutedForeground} />
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.mutedForeground }}>
                      {suburbLine(offer.siteSuburb, offer.siteState)}
                      {offer.propertyType ? ` · ${propertyLabel(offer.propertyType)}` : ""}
                    </Text>
                  </View>

                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      backgroundColor: c.secondary,
                      borderRadius: 12,
                      padding: 12,
                      marginTop: 12,
                      gap: 14,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text
                        style={{ fontFamily: Fonts.medium, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}
                      >
                        YOUR PAY
                      </Text>
                      <Text style={{ fontFamily: Fonts.bold, fontSize: 21, color: c.foreground, marginTop: 2 }}>
                        {fmtMoney(offer.payAmount)}
                      </Text>
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground, marginTop: 1 }}>
                        {payBasis(offer.payType, offer.durationHours)}
                      </Text>
                    </View>
                    <View style={{ width: 1, alignSelf: "stretch", backgroundColor: c.border }} />
                    <View style={{ flex: 1.3 }}>
                      <Text
                        style={{ fontFamily: Fonts.medium, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}
                      >
                        WHEN
                      </Text>
                      <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground, marginTop: 3 }}>
                        {offer.scheduledDate
                          ? fmtDayLabel(offer.scheduledDate)
                          : days.length > 1
                            ? `${fmtDayLabel(days[0])} to ${fmtDayLabel(days[days.length - 1])}`
                            : fmtDayLabel(days[0] ?? null)}
                      </Text>
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground }}>
                        {fmtTime(offer.startTime)} · {fmtHours(offer.durationHours)}
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 11 }}>
                    {offer.areaM2 ? (
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.mutedForeground }}>
                        {offer.areaM2} m²
                      </Text>
                    ) : null}
                    {offer.crewSize > 1 ? (
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.mutedForeground }}>
                        {offer.areaM2 ? " · " : ""}
                        {offer.crewSize} on site
                      </Text>
                    ) : null}
                    {offer.furnitureOnSite ? (
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: "#8A5A11" }}>
                        · Furniture on site
                      </Text>
                    ) : null}
                    {offer.mode === "broadcast" ? (
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.primary }}>
                        · First in wins
                      </Text>
                    ) : null}
                  </View>

                  {offer.description ? (
                    <Text
                      style={{
                        fontFamily: Fonts.sans,
                        fontSize: 13.5,
                        color: c.foreground,
                        marginTop: 10,
                        lineHeight: 19,
                      }}
                    >
                      {offer.description}
                    </Text>
                  ) : null}

                  {!holding ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 11 }}>
                      <Ionicons name="lock-closed-outline" size={13} color={c.mutedForeground} />
                      <Text
                        style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, flex: 1, lineHeight: 17 }}
                      >
                        Street address and the site contact come through the moment the job is yours.
                      </Text>
                    </View>
                  ) : null}

                  {days.length > 1 && !holding ? (
                    <View style={{ marginTop: 13 }}>
                      <Text
                        style={{ fontFamily: Fonts.medium, fontSize: 10, letterSpacing: 1, color: c.mutedForeground }}
                      >
                        PICK YOUR DAY
                      </Text>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 7 }}>
                        {days.map((d) => {
                          const on = chosen === d;
                          return (
                            <Pressable
                              key={d}
                              onPress={() => setDayPick((prev) => ({ ...prev, [offer.offerId]: d }))}
                              style={{
                                paddingHorizontal: 12,
                                paddingVertical: 8,
                                borderRadius: 10,
                                borderWidth: 1,
                                borderColor: on ? c.foreground : c.border,
                                backgroundColor: on ? c.foreground : "transparent",
                              }}
                            >
                              <Text
                                style={{
                                  fontFamily: on ? Fonts.bold : Fonts.medium,
                                  fontSize: 12.5,
                                  color: on ? "#FFFFFF" : c.foreground,
                                }}
                              >
                                {fmtDayLabel(d)}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 7 }}>
                        The office left the day open. The one you pick is the one that gets locked in.
                      </Text>
                    </View>
                  ) : null}

                  {holding ? (
                    <View
                      style={{
                        flexDirection: "row",
                        gap: 10,
                        backgroundColor: "#FDF3E2",
                        borderRadius: 12,
                        padding: 12,
                        marginTop: 13,
                      }}
                    >
                      <Ionicons name="time-outline" size={18} color="#8A5A11" />
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontFamily: Fonts.bold, fontSize: 13.5, color: "#8A5A11" }}>
                          You're holding this one
                        </Text>
                        <Text
                          style={{
                            fontFamily: Fonts.sans,
                            fontSize: 12.5,
                            color: "#8A5A11",
                            marginTop: 3,
                            lineHeight: 17,
                          }}
                        >
                          {offer.chosenDate ? `${fmtDayLabel(offer.chosenDate)}, ` : ""}confirms automatically around{" "}
                          {holdClock(offer.provisionalUntil)}. Nothing else to do.
                        </Text>
                      </View>
                    </View>
                  ) : null}

                  <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                    <Pressable
                      disabled={busy || holding}
                      onPress={() => void onAccept(offer)}
                      style={({ pressed }) => ({
                        flex: 2,
                        display: holding ? "none" : "flex",
                        backgroundColor: c.primary,
                        borderRadius: 12,
                        paddingVertical: 15,
                        alignItems: "center",
                        opacity: pressed || busy ? 0.75 : 1,
                      })}
                    >
                      {busy ? (
                        <ActivityIndicator color="#FFFFFF" />
                      ) : (
                        <Text style={{ fontFamily: Fonts.bold, fontSize: 15.5, color: "#FFFFFF" }}>I'll take it</Text>
                      )}
                    </Pressable>
                    <Pressable
                      disabled={busy}
                      onPress={() => {
                        setError(null);
                        setReason("");
                        setDeclining(offer);
                      }}
                      style={({ pressed }) => ({
                        flex: 1,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: c.border,
                        paddingVertical: 15,
                        alignItems: "center",
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.mutedForeground }}>
                        {holding ? "Give it up" : "Can't"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <Modal visible={declining !== null} animationType="slide" transparent onRequestClose={() => setDeclining(null)}>
        <KeyboardAvoidingView
          style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={0}
        >
          <View
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              paddingBottom: Math.max(32, bottomInset + 16),
            }}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>Why can't you do it?</Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, marginTop: 5 }}>
              The office needs a reason so they can get it covered. A few words is plenty.
            </Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Already booked that day…"
              placeholderTextColor={c.mutedForeground}
              multiline
              style={{
                marginTop: 14,
                minHeight: 88,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                padding: 12,
                fontFamily: Fonts.sans,
                fontSize: 15,
                color: c.foreground,
                textAlignVertical: "top",
              }}
            />
            {error ? (
              <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.destructive, marginTop: 8 }}>
                {error}
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
              <Pressable
                onPress={() => {
                  setDeclining(null);
                  setError(null);
                }}
                style={{
                  flex: 1,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: c.border,
                  paddingVertical: 14,
                  alignItems: "center",
                }}
              >
                <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.mutedForeground }}>Back</Text>
              </Pressable>
              <Pressable
                disabled={decline.isPending}
                onPress={() => void onDecline()}
                style={{
                  flex: 1.4,
                  borderRadius: 12,
                  backgroundColor: c.foreground,
                  paddingVertical: 14,
                  alignItems: "center",
                  opacity: decline.isPending ? 0.7 : 1,
                }}
              >
                {decline.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: "#FFFFFF" }}>Send it</Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
