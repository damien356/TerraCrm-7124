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
import { siteUrl } from "@/lib/api";
import { Colors, Fonts } from "@/constants/theme";

const c = Colors.light;

/**
 * A sign-in that throws (rather than coming back with res.error) used to say
 * "Couldn't reach the server" whatever the cause. This checks whether the
 * server answers at all, so the message says which it is, and keeps the
 * phone's own error text so a screenshot tells us what went wrong.
 */
async function explainThrow(e: unknown): Promise<string> {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? "unknown");
  let reachable = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${siteUrl}/api/auth/get-session`, { signal: ctl.signal, credentials: "omit" });
    clearTimeout(t);
    reachable = r.status < 500;
  } catch {
    reachable = false;
  }
  const host = siteUrl.replace(/^https?:\/\//, "") || "no server set";
  return reachable
    ? `Sign-in failed on this phone. Send a screenshot to the office.\n(${host} · ${detail})`
    : `Couldn't reach the server. Check your connection and try again.\n(${host} · ${detail})`;
}

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "email" | "google">(null);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithEmail() {
    setError(null);
    setBusy("email");
    try {
      // Pasting from a text message or an autofill tends to bring a space along
      // with it, and nobody's password here ends in one.
      const res = await authClient.signIn.email({ email: email.trim(), password: password.trim() });
      if (res.error) setError(res.error.message ?? "Couldn't sign you in.");
    } catch (e) {
      // A dropped connection or a CORS block throws instead of resolving with
      // res.error. Without this catch, busy is never cleared and the button
      // spins forever with no explanation.
      setError(await explainThrow(e));
    } finally {
      setBusy(null);
    }
  }

  async function signInWithGoogle() {
    setError(null);
    setBusy("google");
    try {
      const res = await authClient.managedAuth.signIn({ provider: "google" });
      if (res.error && res.error.code !== "AUTH_SESSION_DISMISSED") {
        setError(res.error.message ?? "Couldn't sign you in.");
      }
    } catch (e) {
      setError(await explainThrow(e));
    } finally {
      setBusy(null);
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
            autoCorrect={false}
            spellCheck={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
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
          {/* A phone keyboard will happily capitalise or autocorrect the first
              thing typed into a password box, and the crew can't see what went
              in to spot it. Both off, and an eye to check the typing. */}
          <View style={{ position: "relative", justifyContent: "center" }}>
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textContentType="password"
              autoComplete="current-password"
              onSubmitEditing={() => {
                if (email && password && busy === null) void signInWithEmail();
              }}
              returnKeyType="go"
              placeholder="••••••••"
              placeholderTextColor="rgba(255,255,255,0.3)"
              style={{
                height: 50,
                borderRadius: 10,
                backgroundColor: "rgba(255,255,255,0.07)",
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.12)",
                paddingLeft: 14,
                paddingRight: 48,
                color: "#FFFFFF",
                fontFamily: Fonts.sans,
                fontSize: 15,
              }}
            />
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={10}
              style={{ position: "absolute", right: 12, padding: 4 }}
            >
              <Ionicons
                name={showPassword ? "eye-off-outline" : "eye-outline"}
                size={20}
                color="rgba(255,255,255,0.45)"
              />
            </Pressable>
          </View>

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
