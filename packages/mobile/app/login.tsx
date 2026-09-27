import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { authClient } from "@/lib/auth";
import { Colors, Fonts } from "@/constants/theme";

const c = Colors.light;

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "email" | "google">(null);
  const [error, setError] = useState<string | null>(null);

  async function signInWithEmail() {
    setError(null);
    setBusy("email");
    const res = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(null);
    if (res.error) setError(res.error.message ?? "Couldn't sign you in.");
  }

  async function signInWithGoogle() {
    setError(null);
    setBusy("google");
    const res = await authClient.managedAuth.signIn({ provider: "google" });
    setBusy(null);
    if (res.error && res.error.code !== "AUTH_SESSION_DISMISSED") {
      setError(res.error.message ?? "Couldn't sign you in.");
    }
  }

  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={{ flex: 1, backgroundColor: c.sidebar }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ marginBottom: 36 }}>
            <Image
              source={require("../assets/terra-logo-reverse.png")}
              resizeMode="contain"
              style={{ width: 128, height: 160, marginBottom: 20 }}
            />
            <Text style={{ fontFamily: Fonts.bold, fontSize: 28, color: "#FFFFFF", lineHeight: 34 }}>
              Terra
            </Text>
            <Text style={{ fontFamily: Fonts.sans, fontSize: 14, color: "rgba(255,255,255,0.55)", marginTop: 6 }}>
              Your work for the day, your offers, and your pay. Nothing else.
            </Text>
          </View>

          <Text
            style={{
              fontFamily: Fonts.medium,
              fontSize: 11,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.4)",
              marginBottom: 6,
            }}
          >
            Email
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="you@terraflooring.com.au"
            placeholderTextColor="rgba(255,255,255,0.3)"
            style={{
              height: 50,
              borderRadius: 10,
              backgroundColor: "rgba(255,255,255,0.07)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
              paddingHorizontal: 14,
              color: "#FFFFFF",
              fontFamily: Fonts.sans,
              fontSize: 15,
              marginBottom: 14,
            }}
          />

          <Text
            style={{
              fontFamily: Fonts.medium,
              fontSize: 11,
              letterSpacing: 1.2,
              textTransform: "uppercase",
              color: "rgba(255,255,255,0.4)",
              marginBottom: 6,
            }}
          >
            Password
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor="rgba(255,255,255,0.3)"
            style={{
              height: 50,
              borderRadius: 10,
              backgroundColor: "rgba(255,255,255,0.07)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.12)",
              paddingHorizontal: 14,
              color: "#FFFFFF",
              fontFamily: Fonts.sans,
              fontSize: 15,
            }}
          />

          {error ? (
            <Text style={{ fontFamily: Fonts.sans, fontSize: 13, color: "#F0A39A", marginTop: 14 }}>{error}</Text>
          ) : null}

          <Pressable
            onPress={signInWithEmail}
            disabled={!email || !password || busy !== null}
            style={{
              height: 52,
              borderRadius: 10,
              backgroundColor: "#BC9558",
              alignItems: "center",
              justifyContent: "center",
              marginTop: 20,
              opacity: !email || !password || busy !== null ? 0.55 : 1,
            }}
          >
            {busy === "email" ? (
              <ActivityIndicator color="#1C1B1A" />
            ) : (
              <Text style={{ fontFamily: Fonts.bold, fontSize: 16, color: "#1C1B1A" }}>Sign in</Text>
            )}
          </Pressable>

          <View style={{ flexDirection: "row", alignItems: "center", marginVertical: 20 }}>
            <View style={{ flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.12)" }} />
            <Text
              style={{
                fontFamily: Fonts.sans,
                fontSize: 12,
                color: "rgba(255,255,255,0.4)",
                marginHorizontal: 12,
              }}
            >
              or
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.12)" }} />
          </View>

          <Pressable
            onPress={signInWithGoogle}
            disabled={busy !== null}
            style={{
              height: 52,
              borderRadius: 10,
              backgroundColor: "#FFFFFF",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              opacity: busy !== null ? 0.55 : 1,
            }}
          >
            {busy === "google" ? (
              <ActivityIndicator color={c.foreground} />
            ) : (
              <>
                <Ionicons name="logo-google" size={18} color="#1C1B1A" />
                <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: "#1C1B1A" }}>
                  Continue with Google
                </Text>
              </>
            )}
          </Pressable>

          <Text
            style={{
              fontFamily: Fonts.sans,
              fontSize: 12,
              color: "rgba(255,255,255,0.35)",
              textAlign: "center",
              marginTop: 24,
              lineHeight: 18,
            }}
          >
            Trouble getting in? Ring the office and they'll re-send your invite.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
