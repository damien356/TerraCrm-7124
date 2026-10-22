import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Fonts } from "@/constants/theme";
import { useMyBank, useSetMyBank } from "@/queries/field";

const c = Colors.light;

const input = {
  borderWidth: 1,
  borderColor: c.border,
  borderRadius: 10,
  paddingHorizontal: 10,
  paddingVertical: 9,
  marginTop: 6,
  fontFamily: Fonts.sans,
  fontSize: 15,
  color: c.foreground,
  backgroundColor: c.background,
} as const;

function errText(e: unknown) {
  const m = (e as { message?: string } | null)?.message;
  return m && m.length < 200 ? m : "Couldn't save. Check your signal and try again.";
}

/**
 * Your bank details, for your invoices (Damien 22 Oct). Only you enter them,
 * here. Nothing is filled in for you, and what is on file only changes when
 * you save new details.
 */
export function BankDetailsCard() {
  const bank = useMyBank();
  const save = useSetMyBank();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [bsb, setBsb] = useState("");
  const [acc, setAcc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // An older server has no route for this. Show nothing rather than an error.
  if (bank.isError || !bank.data) return null;
  const d = bank.data;

  const open = () => {
    setName(d.accountName ?? "");
    setBsb("");
    setAcc("");
    setError(null);
    setSaved(false);
    setEditing(true);
  };

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync({ accountName: name, bsb, accountNumber: acc });
      setEditing(false);
      setSaved(true);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
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
        BANK DETAILS FOR YOUR INVOICES
      </Text>
      {!editing ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 }}>
            <Ionicons
              name={d.onFile ? "shield-checkmark-outline" : "alert-circle-outline"}
              size={18}
              color={d.onFile ? c.success : c.warning}
            />
            <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: c.foreground, flex: 1 }}>
              {d.onFile
                ? `${d.accountName} · BSB ${d.bsb} · account ending ${d.accountEnding}`
                : "Not on file yet. Add them before you send your first invoice."}
            </Text>
          </View>
          {saved ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 12.5, color: c.success, marginTop: 8 }}>
              Saved. A note goes on your file for the office that your bank details changed.
            </Text>
          ) : null}
          <Pressable
            onPress={open}
            style={({ pressed }) => ({
              alignSelf: "flex-start",
              marginTop: 10,
              backgroundColor: d.onFile ? c.secondary : c.primary,
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 9,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ fontFamily: Fonts.bold, fontSize: 12.5, color: d.onFile ? c.foreground : "#FFFFFF" }}>
              {d.onFile ? "Change bank details" : "Add bank details"}
            </Text>
          </Pressable>
        </>
      ) : (
        <View style={{ marginTop: 8 }}>
          <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.mutedForeground, marginTop: 6 }}>Account name</Text>
          <TextInput value={name} onChangeText={setName} autoCapitalize="words" autoCorrect={false} style={input} />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.mutedForeground, marginTop: 10 }}>BSB</Text>
          <TextInput
            value={bsb}
            onChangeText={setBsb}
            keyboardType="number-pad"
            placeholder="6 digits"
            placeholderTextColor={c.mutedForeground}
            maxLength={7}
            autoCorrect={false}
            style={input}
          />
          <Text style={{ fontFamily: Fonts.medium, fontSize: 12.5, color: c.mutedForeground, marginTop: 10 }}>
            Account number
          </Text>
          <TextInput
            value={acc}
            onChangeText={setAcc}
            keyboardType="number-pad"
            maxLength={12}
            autoCorrect={false}
            style={input}
          />
          <Text style={{ fontFamily: Fonts.sans, fontSize: 12, lineHeight: 17, color: c.mutedForeground, marginTop: 10 }}>
            Your own account, the one your invoices are paid into. Only you can enter or change it here.
          </Text>
          {error ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: c.destructive, marginTop: 8 }}>{error}</Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
            <Pressable
              onPress={() => void submit()}
              disabled={save.isPending}
              style={({ pressed }) => ({
                backgroundColor: c.primary,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 9,
                opacity: pressed || save.isPending ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: Fonts.bold, fontSize: 13.5, color: "#FFFFFF" }}>
                {save.isPending ? "Saving..." : "Save bank details"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setEditing(false)}
              style={({ pressed }) => ({
                borderWidth: 1,
                borderColor: c.border,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 9,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: Fonts.medium, fontSize: 13.5, color: c.foreground }}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}
