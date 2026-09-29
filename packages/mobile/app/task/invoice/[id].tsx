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
import { Colors, Fonts } from "@/constants/theme";
import { fmtMoney2 } from "@/lib/format";
import {
  useInvoiceDownloadUrl,
  useInvoicePreview,
  useMyVariations,
  useRequestVariation,
  useSubmitInvoice,
} from "@/queries/invoices";

const c = Colors.light;

const STATUS_LABEL: Record<string, string> = {
  submitted: "Submitted",
  approved: "Approved",
  scheduled_for_payment: "Scheduled for payment",
  paid: "Paid",
};

const STATUS_COLOUR: Record<string, string> = {
  submitted: c.primary,
  approved: c.warning,
  scheduled_for_payment: c.warning,
  paid: c.success,
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6 }}>
      <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground }}>{label}</Text>
      <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>{value}</Text>
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
        marginTop: 14,
      }}
    >
      {children}
    </View>
  );
}

export default function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const taskId = Number(id);

  const preview = useInvoicePreview(taskId);
  const variations = useMyVariations(taskId);
  const requestVariation = useRequestVariation();
  const submit = useSubmitInvoice();
  const downloadUrl = useInvoiceDownloadUrl();

  const [stage, setStage] = useState<"summary" | "confirm">("summary");
  const [error, setError] = useState<string | null>(null);
  const [varSheet, setVarSheet] = useState(false);
  const [varDesc, setVarDesc] = useState("");
  const [varAmount, setVarAmount] = useState("");
  const [downloading, setDownloading] = useState(false);

  const p = preview.data;

  if (preview.isLoading) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} style={{ marginTop: 40 }} />
      </SafeAreaView>
    );
  }

  if (preview.isError || !p) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background, padding: 20 }}>
        <Pressable onPress={() => router.back()} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name="chevron-back" size={20} color={c.foreground} />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>Back</Text>
        </Pressable>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.foreground, marginTop: 24 }}>
          Can't open that invoice
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.mutedForeground, marginTop: 6 }}>
          {preview.error instanceof Error ? preview.error.message : "This task isn't marked complete yet."}
        </Text>
      </SafeAreaView>
    );
  }

  async function onSubmit() {
    setError(null);
    try {
      await submit.mutateAsync({ taskId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit that. Try again.");
    }
  }

  async function onDownload() {
    const invoiceId = p?.existingInvoiceId;
    if (!invoiceId) return;
    setError(null);
    setDownloading(true);
    try {
      const result = await downloadUrl.mutateAsync({ invoiceId });
      await Linking.openURL(result.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open that PDF. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  async function onSendVariation() {
    setError(null);
    const amount = Number(varAmount.replace(/[^0-9.]/g, ""));
    if (varDesc.trim().length < 3) {
      setError("Describe the extra first.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a dollar amount for it.");
      return;
    }
    try {
      await requestVariation.mutateAsync({ taskId, description: varDesc.trim(), amount });
      setVarSheet(false);
      setVarDesc("");
      setVarAmount("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    }
  }

  const pendingVariations = (variations.data ?? []).filter((v) => v.status === "pending");
  const locked = p.alreadySubmitted;

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: c.background }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: 6,
        }}
      >
        <Pressable
          onPress={() => (stage === "confirm" ? setStage("summary") : router.back())}
          style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 }}
        >
          <Ionicons name="chevron-back" size={20} color={c.foreground} />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: c.foreground }}>Back</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140 }}>
        <Text style={{ fontFamily: Fonts.bold, fontSize: 22, color: c.foreground }}>
          {locked ? "Your invoice" : stage === "confirm" ? "Confirm your invoice" : "Invoice for this job"}
        </Text>
        <Text style={{ fontFamily: Fonts.sans, fontSize: 13.5, color: c.mutedForeground, marginTop: 4 }}>
          Job #{p.job.number} · {p.job.taskTitle}
        </Text>
        {p.job.siteAddress ? (
          <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground }}>{p.job.siteAddress}</Text>
        ) : null}

        {locked ? (
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
                STATUS
              </Text>
              <View
                style={{
                  backgroundColor: STATUS_COLOUR[p.existingStatus ?? "submitted"] ?? c.primary,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 8,
                }}
              >
                <Text style={{ fontFamily: Fonts.bold, fontSize: 12, color: "#FFFFFF" }}>
                  {STATUS_LABEL[p.existingStatus ?? "submitted"] ?? "Submitted"}
                </Text>
              </View>
            </View>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, marginTop: 10 }}>
              This invoice is locked. Terra pays it through their own process, you'll see the status update here as it
              moves along.
            </Text>
          </Card>
        ) : null}

        {/* Read-only work summary, always visible. */}
        <Card>
          <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
            WORK COMPLETED
          </Text>
          {p.lineItems.map((l, idx) => (
            <View key={idx} style={{ marginTop: idx === 0 ? 10 : 8 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground, flex: 1 }}>
                  {l.description}
                </Text>
                <Text style={{ fontFamily: Fonts.bold, fontSize: 13.5, color: c.foreground }}>
                  ${fmtMoney2(l.total)}
                </Text>
              </View>
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12, color: c.mutedForeground }}>
                {l.qty} {l.unit} {l.rate != null ? `@ $${fmtMoney2(l.rate)}` : ""}
              </Text>
            </View>
          ))}
          <View style={{ height: 1, backgroundColor: c.border, marginVertical: 10 }} />
          <Row label="Subtotal" value={`$${fmtMoney2(p.subtotal)}`} />
          {p.gstAmount > 0 ? <Row label="GST (10%)" value={`$${fmtMoney2(p.gstAmount)}`} /> : null}
          <View style={{ height: 1, backgroundColor: c.border, marginVertical: 10 }} />
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: c.foreground }}>Total payable</Text>
            <Text style={{ fontFamily: Fonts.bold, fontSize: 18, color: c.primary }}>${fmtMoney2(p.total)}</Text>
          </View>
        </Card>

        {!locked ? (
          <>
            <Pressable
              onPress={() => setVarSheet(true)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                marginTop: 14,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                paddingVertical: 12,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Ionicons name="add-circle-outline" size={17} color={c.foreground} />
              <Text style={{ fontFamily: Fonts.medium, fontSize: 14, color: c.foreground }}>
                Request variation / extra
              </Text>
            </Pressable>
            {pendingVariations.length > 0 ? (
              <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground, marginTop: 8 }}>
                {pendingVariations.length} waiting on the office, they'll show up here once approved.
              </Text>
            ) : null}
          </>
        ) : null}

        {stage === "confirm" && !locked ? (
          <Card>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 10.5, letterSpacing: 1, color: c.mutedForeground }}>
              YOUR DETAILS ON THIS INVOICE
            </Text>
            <Row label="Trading as" value={p.profile.tradingName || p.profile.installerName} />
            <Row label="ABN" value={p.profile.abn ?? "-"} />
            <Row label="GST registered" value={p.profile.gstRegistered ? "Yes" : "No"} />
            <Row label="Address" value={p.profile.businessAddress ?? "-"} />
            <Row label="Email" value={p.profile.invoiceEmail ?? "-"} />
            <Row label="Invoice number" value={p.profile.nextInvoiceNumber != null ? String(p.profile.nextInvoiceNumber) : "-"} />
            <View style={{ height: 1, backgroundColor: c.border, marginVertical: 10 }} />
            <Row label="Bank account" value={p.profile.bankAccountName ?? "-"} />
            <Row label="BSB" value={p.profile.bankBsb ?? "-"} />
            <Row label="Account no." value={p.profile.bankAccountNumber ?? "-"} />
            <View style={{ height: 1, backgroundColor: c.border, marginVertical: 10 }} />
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.mutedForeground }}>Billed to</Text>
            <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground, marginTop: 2 }}>
              Arclan Pty Ltd t/a Terra Flooring
            </Text>
          </Card>
        ) : null}

        {error ? (
          <Text style={{ fontFamily: Fonts.medium, fontSize: 13, color: c.destructive, marginTop: 12 }}>{error}</Text>
        ) : null}

        {locked ? (
          <Pressable
            disabled={downloading}
            onPress={() => void onDownload()}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              marginTop: 16,
              backgroundColor: c.foreground,
              borderRadius: 12,
              paddingVertical: 14,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Ionicons name="download-outline" size={17} color="#FFFFFF" />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: "#FFFFFF" }}>Download PDF</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      {!locked ? (
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
          {p.blockedReason ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.destructive, marginBottom: 10 }}>
              {p.blockedReason}
            </Text>
          ) : null}
          <Pressable
            disabled={!p.canSubmit || submit.isPending}
            onPress={() => (stage === "summary" ? setStage("confirm") : void onSubmit())}
            style={({ pressed }) => ({
              backgroundColor: !p.canSubmit ? c.secondary : c.primary,
              borderRadius: 14,
              paddingVertical: 17,
              alignItems: "center",
              opacity: pressed || submit.isPending ? 0.8 : 1,
            })}
          >
            {submit.isPending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text
                style={{
                  fontFamily: Fonts.bold,
                  fontSize: 16.5,
                  color: !p.canSubmit ? c.mutedForeground : "#FFFFFF",
                }}
              >
                {stage === "summary" ? "CREATE MY INVOICE" : "SUBMIT INVOICE"}
              </Text>
            )}
          </Pressable>
        </View>
      ) : null}

      <Modal visible={varSheet} transparent animationType="slide" onRequestClose={() => setVarSheet(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1, justifyContent: "flex-end" }}
        >
          <Pressable style={{ flex: 1 }} onPress={() => setVarSheet(false)} />
          <View
            style={{
              backgroundColor: c.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 20,
              paddingBottom: 34,
            }}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 17, color: c.foreground }}>Request an extra</Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.mutedForeground, marginTop: 4 }}>
              Tell the office what came up and what it's worth. It only lands on your invoice once they approve it.
            </Text>
            <TextInput
              value={varDesc}
              onChangeText={setVarDesc}
              placeholder="What happened…"
              placeholderTextColor={c.mutedForeground}
              multiline
              style={{
                marginTop: 14,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                padding: 12,
                minHeight: 70,
                fontFamily: Fonts.sans,
                fontSize: 14,
                color: c.foreground,
              }}
            />
            <TextInput
              value={varAmount}
              onChangeText={setVarAmount}
              placeholder="Amount, e.g. 85"
              placeholderTextColor={c.mutedForeground}
              keyboardType="decimal-pad"
              style={{
                marginTop: 10,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 12,
                padding: 12,
                fontFamily: Fonts.sans,
                fontSize: 14,
                color: c.foreground,
              }}
            />
            <Pressable
              disabled={requestVariation.isPending}
              onPress={() => void onSendVariation()}
              style={({ pressed }) => ({
                marginTop: 14,
                backgroundColor: c.foreground,
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
                opacity: pressed || requestVariation.isPending ? 0.8 : 1,
              })}
            >
              {requestVariation.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={{ fontFamily: Fonts.bold, fontSize: 14.5, color: "#FFFFFF" }}>Send to the office</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}
