import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Colors, Fonts, tintFor } from "@/constants/theme";
import { fmtDayLabel, fmtHours, fmtMoney, fmtMoney2, fmtTime, statusLabel, unitLabel } from "@/lib/format";
import {
  useAddFieldNote,
  useCompleteTask,
  useMe,
  useReleaseTask,
  useStartTask,
  useTask,
  useTickChecklistItem,
} from "@/queries/field";
import { useShiftLocation } from "@/hooks/use-shift-location";
import { JobFileSection } from "@/components/job-file";

const c = Colors.light;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 22 }}>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1.2, color: c.mutedForeground }}>
        {title}
      </Text>
      <View style={{ marginTop: 9 }}>{children}</View>
    </View>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        padding: 14,
      }}
    >
      {children}
    </View>
  );
}

export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const task = useTask(Number(id));
  const me = useMe();

  const tick = useTickChecklistItem();
  const start = useStartTask();
  const finish = useCompleteTask();
  const release = useReleaseTask();
  const addNote = useAddFieldNote();

  // On-shift location. Off unless they switched sharing on AND this job is running.
  const sharing = useShiftLocation({
    taskId: Number(id),
    running: task.data?.status === "in_progress",
    consented: Boolean(me.data?.locationConsentAt),
  });

  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "note" | "handback">(null);
  const [text, setText] = useState("");
  const [noteSent, setNoteSent] = useState(false);

  const t = task.data;

  if (task.isLoading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (task.isError || !t) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background, padding: 20 }}>
        <Pressable onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name="chevron-back" size={20} color={c.foreground} />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>Back</Text>
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.foreground, marginTop: 24 }}>
          Can't open that job
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 6 }}>
          It may have been handed to someone else. Give the office a call if you think that's wrong.
        </Text>
      </SafeAreaView>
    );
  }

  const tint = tintFor(t.skillGroup);
  const address = [t.siteAddress, t.siteSuburb, t.sitePostcode].filter(Boolean).join(", ");
  const running = t.status === "in_progress";
  const done = t.status === "complete";
  const outstanding = t.checklist.filter((i) => i.required && !i.done).length;

  function openMaps() {
    if (!address) return;
    const q = encodeURIComponent(address);
    const url =
      Platform.OS === "ios" ? `http://maps.apple.com/?daddr=${q}` : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
    void Linking.openURL(url);
  }

  async function onStart() {
    setError(null);
    try {
      await start.mutateAsync({ taskId: t!.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start that.");
    }
  }

  async function onFinish() {
    setError(null);
    try {
      await finish.mutateAsync({ taskId: t!.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't finish that.");
    }
  }

  async function onSubmitSheet() {
    if (!t) return;
    const body = text.trim();
    if (sheet === "handback" && body.length < 3) {
      setError("Give the office a reason so they can cover it.");
      return;
    }
    if (sheet === "note" && body.length === 0) {
      setError("Type something first.");
      return;
    }
    setError(null);
    try {
      if (sheet === "handback") {
        await release.mutateAsync({ taskId: t.id, reason: body });
        setSheet(null);
        setText("");
        router.back();
        return;
      }
      await addNote.mutateAsync({ taskId: t.id, body });
      setSheet(null);
      setText("");
      setNoteSent(true);
      setTimeout(() => setNoteSent(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          backgroundColor: c.card,
        }}
      >
        <Pressable onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Ionicons name="chevron-back" size={22} color={c.foreground} />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>Job #{t.jobNumber}</Text>
        </Pressable>
        <View
          style={{
            backgroundColor: running ? c.primary : done ? c.success : c.secondary,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 7,
          }}
        >
          <Text
            style={{
              fontFamily: Fonts.bold,
              fontSize: 11,
              color: running || done ? "#FFFFFF" : c.mutedForeground,
            }}
          >
            {statusLabel(t.status).toUpperCase()}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ backgroundColor: tint.fill, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6 }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 11.5, color: tint.edge }}>{t.skillName ?? "Work"}</Text>
          </View>
          {t.isSecond ? (
            <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: c.mutedForeground }}>You're 2nd man</Text>
          ) : null}
        </View>

        <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground, marginTop: 10, lineHeight: 30 }}>
          {t.title}
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 4 }}>
          {fmtDayLabel(t.scheduledDate)} · {fmtTime(t.startTime)} · {fmtHours(t.durationHours)}
          {t.areaM2 ? ` · ${t.areaM2} m²` : ""}
        </Text>

        {t.furnitureOnSite ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
              backgroundColor: "#FBEDD8",
              borderRadius: 12,
              padding: 12,
              marginTop: 14,
            }}
          >
            <Ionicons name="bed-outline" size={18} color="#8A5A11" />
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#8A5A11", flex: 1 }}>
              Furniture on site — two of you on this one, allow time to shift it.
            </Text>
          </View>
        ) : null}

        {running && sharing === "sharing" ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
              backgroundColor: "#E9F0EA",
              borderRadius: 12,
              padding: 12,
              marginTop: 14,
            }}
          >
            <Ionicons name="navigate-circle-outline" size={18} color="#2F5F2B" />
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#2F5F2B", flex: 1 }}>
              Location shared with the office while this job runs. It stops when you mark it complete.
            </Text>
          </View>
        ) : null}

        {running && sharing === "no_permission" ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 9,
              backgroundColor: "#FBEDD8",
              borderRadius: 12,
              padding: 12,
              marginTop: 14,
            }}
          >
            <Ionicons name="location-outline" size={18} color="#8A5A11" />
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#8A5A11", flex: 1 }}>
              Location is switched off in this phone's settings, so the office can't see you on the map.
            </Text>
          </View>
        ) : null}

        {error ? (
          <View style={{ backgroundColor: "#FBE3DF", borderRadius: 10, padding: 12, marginTop: 14 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: "#8B2F22" }}>{error}</Text>
          </View>
        ) : null}

        {noteSent ? (
          <View style={{ backgroundColor: "#E4F0E2", borderRadius: 10, padding: 12, marginTop: 14 }}>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: "#2F5F2B" }}>
              Note sent to the office.
            </Text>
          </View>
        ) : null}

        <Section title="WHERE">
          <Card>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 15.5, color: c.foreground }}>
              {address || "Address to come"}
            </Text>
            {t.propertyType ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, marginTop: 2 }}>
                {t.propertyType}
              </Text>
            ) : null}
            <Pressable
              onPress={openMaps}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                marginTop: 12,
                backgroundColor: c.secondary,
                borderRadius: 10,
                paddingVertical: 12,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="navigate-outline" size={17} color={c.foreground} />
              <Text style={{ fontFamily: Fonts.medium, fontSize: 14.5, color: c.foreground }}>Directions</Text>
            </Pressable>
            {t.siteAccessNotes || t.jobAccessNotes ? (
              <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 12, paddingTop: 10 }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 12, color: c.mutedForeground }}>Access</Text>
                <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.foreground, marginTop: 3, lineHeight: 19 }}>
                  {[t.siteAccessNotes, t.jobAccessNotes].filter(Boolean).join(" · ")}
                </Text>
              </View>
            ) : null}
          </Card>
        </Section>

        {t.contacts.length > 0 ? (
          <Section title="WHO'S THERE">
            <Card>
              {t.contacts.map((p, i) => (
                <View
                  key={`${p.name}-${i}`}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: c.border,
                    paddingTop: i === 0 ? 0 : 10,
                    marginTop: i === 0 ? 0 : 10,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>{p.name}</Text>
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground }}>
                      {p.role.replace(/_/g, " ")}
                      {p.onSite ? " · on site" : ""}
                    </Text>
                  </View>
                  {p.mobile ? (
                    <Pressable
                      onPress={() => void Linking.openURL(`tel:${p.mobile}`)}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        backgroundColor: c.primary,
                        paddingHorizontal: 13,
                        paddingVertical: 9,
                        borderRadius: 9,
                        opacity: pressed ? 0.8 : 1,
                      })}
                    >
                      <Ionicons name="call" size={14} color="#FFFFFF" />
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: "#FFFFFF" }}>Call</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </Card>
          </Section>
        ) : null}

        {t.description ? (
          <Section title="THE JOB">
            <Card>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 14.5, color: c.foreground, lineHeight: 21 }}>
                {t.description}
              </Text>
            </Card>
          </Section>
        ) : null}

        {t.crewMate ? (
          <Section title="ON IT WITH YOU">
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>
                    {t.crewMate.name}
                  </Text>
                  <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground }}>
                    Crew of {t.crewSize}
                  </Text>
                </View>
                {t.crewMate.mobile ? (
                  <Pressable
                    onPress={() => void Linking.openURL(`tel:${t.crewMate!.mobile}`)}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      borderWidth: 1,
                      borderColor: c.border,
                      paddingHorizontal: 13,
                      paddingVertical: 9,
                      borderRadius: 9,
                      opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Ionicons name="call-outline" size={14} color={c.foreground} />
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>Call</Text>
                  </Pressable>
                ) : null}
              </View>
            </Card>
          </Section>
        ) : null}

        {t.materials.length > 0 ? (
          <Section title="MATERIALS">
            <Card>
              {t.materials.map((m, i) => (
                <View
                  key={m.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: c.border,
                    paddingVertical: i === 0 ? 0 : 9,
                    paddingBottom: i === 0 ? 9 : 9,
                  }}
                >
                  <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.foreground, flex: 1 }}>
                    {m.description}
                  </Text>
                  <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.mutedForeground }}>
                    {m.qty} {m.unit}
                  </Text>
                </View>
              ))}
              <Text style={{ fontFamily: Fonts.sans, fontSize: 11.5, color: c.mutedForeground, marginTop: 4 }}>
                Quantities only — pricing stays with the office.
              </Text>
            </Card>
          </Section>
        ) : null}

        {t.checklist.length > 0 ? (
          <Section title={`CHECKLIST${outstanding > 0 ? ` · ${outstanding} MUST BE DONE` : ""}`}>
            <Card>
              {t.checklist.map((item, i) => (
                <Pressable
                  key={item.id}
                  onPress={() => {
                    setError(null);
                    tick.mutate({ id: item.id, done: !item.done });
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 11,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: c.border,
                    paddingVertical: 11,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Ionicons
                    name={item.done ? "checkbox" : "square-outline"}
                    size={23}
                    color={item.done ? c.success : c.mutedForeground}
                  />
                  <Text
                    style={{
                      fontFamily: Fonts.sans,
                      fontSize: 14.5,
                      color: item.done ? c.mutedForeground : c.foreground,
                      flex: 1,
                      textDecorationLine: item.done ? "line-through" : "none",
                    }}
                  >
                    {item.label}
                    {item.required ? (
                      <Text style={{ fontFamily: Fonts.medium, color: c.primary }}> *</Text>
                    ) : null}
                  </Text>
                </Pressable>
              ))}
            </Card>
          </Section>
        ) : null}

        <Section title="JOB FILE">
          <JobFileSection taskId={t.id} jobId={t.jobId} />
        </Section>

        <Section title="YOUR PAY">
          <Card>
            {t.payBreakdown && t.payBreakdown.length > 0 ? (
              <View>
                {t.payBreakdown.map((line, idx) => (
                  <View
                    key={idx}
                    style={{
                      flexDirection: "row",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      paddingVertical: 8,
                      borderTopWidth: idx === 0 ? 0 : 1,
                      borderTopColor: c.border,
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: 10 }}>
                      <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>{line.name}</Text>
                      <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground, marginTop: 2 }}>
                        {line.qty} {unitLabel(line.unit)}
                        {line.rate != null ? ` @ ${fmtMoney2(line.rate)}/${unitLabel(line.unit)}` : ""}
                        {" +GST"}
                      </Text>
                    </View>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 14, color: c.foreground }}>
                      {line.total != null ? fmtMoney2(line.total) : "—"}
                    </Text>
                  </View>
                ))}

                <View style={{ borderTopWidth: 1, borderTopColor: c.border, marginTop: 4, paddingTop: 10, gap: 4 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}>
                      Total ex GST
                    </Text>
                    <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>
                      {fmtMoney2(t.payTotalExGst)}
                    </Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: c.foreground }}>Total inc GST</Text>
                    <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.primary }}>
                      {fmtMoney2(t.payTotalExGst != null ? t.payTotalExGst * 1.1 : null)}
                    </Text>
                  </View>
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: c.foreground, flex: 1 }}>
                  {fmtMoney(t.payAmount)}
                  <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}>
                    {t.payType === "hourly" ? " /hr" : t.payType === "per_m2" ? " /m²" : " for the job"}
                  </Text>
                </Text>
                <Ionicons name="wallet-outline" size={22} color={c.mutedForeground} />
              </View>
            )}
          </Card>
        </Section>

        <View style={{ flexDirection: "row", gap: 10, marginTop: 18 }}>
          <Pressable
            onPress={() => {
              setError(null);
              setText("");
              setSheet("note");
            }}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 12,
              paddingVertical: 13,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={c.foreground} />
            <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>Note the office</Text>
          </Pressable>
          {!done ? (
            <Pressable
              onPress={() => {
                setError(null);
                setText("");
                setSheet("handback");
              }}
              style={({ pressed }) => ({
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                paddingVertical: 13,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="return-up-back-outline" size={16} color={c.destructive} />
              <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.destructive }}>Hand back</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>

      {!done ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: 16,
            paddingBottom: 26,
            backgroundColor: c.card,
            borderTopWidth: 1,
            borderTopColor: c.border,
          }}
        >
          <Pressable
            disabled={start.isPending || finish.isPending}
            onPress={() => void (running ? onFinish() : onStart())}
            style={({ pressed }) => ({
              backgroundColor: running ? c.success : c.primary,
              borderRadius: 14,
              paddingVertical: 17,
              alignItems: "center",
              opacity: pressed || start.isPending || finish.isPending ? 0.8 : 1,
            })}
          >
            {start.isPending || finish.isPending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={{ fontFamily: Fonts.bold, fontSize: 16.5, color: "#FFFFFF" }}>
                {running ? "Finish this job" : "Start this job"}
              </Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: 16,
            paddingBottom: 26,
            backgroundColor: c.card,
            borderTopWidth: 1,
            borderTopColor: c.border,
          }}
        >
          <Pressable
            onPress={() => router.push(`/task/invoice/${t.id}`)}
            style={({ pressed }) => ({
              backgroundColor: c.primary,
              borderRadius: 14,
              paddingVertical: 17,
              alignItems: "center",
              flexDirection: "row",
              justifyContent: "center",
              gap: 8,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Ionicons name="document-text-outline" size={18} color="#FFFFFF" />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 16.5, color: "#FFFFFF" }}>Invoice this job</Text>
          </Pressable>
        </View>
      )}

      <Modal visible={sheet !== null} transparent animationType="slide" onRequestClose={() => setSheet(null)}>
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
              paddingBottom: 32,
            }}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 19, color: c.foreground }}>
              {sheet === "handback" ? "Hand this job back?" : "Note to the office"}
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, marginTop: 5, lineHeight: 19 }}>
              {sheet === "handback"
                ? "It goes back to the office to re-book, and they'll see your reason. A reason is required."
                : "Goes straight onto the job so the office sees it — extra work, a problem, a delay."}
            </Text>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={sheet === "handback" ? "Van's broken down…" : "Subfloor's damp in the back bedroom…"}
              placeholderTextColor={c.mutedForeground}
              multiline
              style={{
                marginTop: 14,
                minHeight: 96,
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
                  setSheet(null);
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
                <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.mutedForeground }}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={addNote.isPending || release.isPending}
                onPress={() => void onSubmitSheet()}
                style={{
                  flex: 1.4,
                  borderRadius: 12,
                  backgroundColor: sheet === "handback" ? c.destructive : c.foreground,
                  paddingVertical: 14,
                  alignItems: "center",
                  opacity: addNote.isPending || release.isPending ? 0.7 : 1,
                }}
              >
                {addNote.isPending || release.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={{ fontFamily: Fonts.bold, fontSize: 15, color: "#FFFFFF" }}>
                    {sheet === "handback" ? "Hand it back" : "Send"}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
