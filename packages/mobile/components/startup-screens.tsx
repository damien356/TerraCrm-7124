import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { QueryClient } from "@tanstack/react-query";
import { Colors, Fonts } from "@/constants/theme";
import { authClient, forgetLoginOnPhone } from "@/lib/auth";
import { forgetSignedIn, onFatal, queueProblem, setLoginNote } from "@/lib/crash-guard";

/**
 * What the crew see instead of the app closing: a plain message and a way out.
 * Same dark look as Sign in. The small grey line under the message is the
 * phone's own error text, so a screenshot to the office says what happened.
 */

const GOLD = "#BC9558";

function Shell({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView edges={["top", "left", "right", "bottom"]} style={{ flex: 1, backgroundColor: Colors.light.sidebar }}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}>
        <Image
          source={require("../assets/terra-logo-reverse.png")}
          resizeMode="contain"
          style={{ width: 96, height: 120, marginBottom: 24 }}
        />
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

function Title({ children }: { children: ReactNode }) {
  return <Text style={{ fontFamily: Fonts.bold, fontSize: 24, color: "#FFFFFF", lineHeight: 30 }}>{children}</Text>;
}

function Body({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontFamily: Fonts.sans, fontSize: 15, color: "rgba(255,255,255,0.7)", marginTop: 10, lineHeight: 22 }}>
      {children}
    </Text>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <Text selectable style={{ fontFamily: Fonts.sans, fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 14 }}>
      {children}
    </Text>
  );
}

function Action({ label, onPress, busy, quiet }: { label: string; onPress: () => void; busy?: boolean; quiet?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={({ pressed }) => ({
        height: 52,
        borderRadius: 10,
        backgroundColor: quiet ? "transparent" : GOLD,
        borderWidth: quiet ? 1 : 0,
        borderColor: "rgba(255,255,255,0.18)",
        alignItems: "center",
        justifyContent: "center",
        marginTop: quiet ? 12 : 28,
        opacity: busy ? 0.6 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color="#FFFFFF" />
      ) : (
        <Text style={{ fontFamily: Fonts.medium, fontSize: 15, color: quiet ? "rgba(255,255,255,0.8)" : "#1C1B1A" }}>{label}</Text>
      )}
    </Pressable>
  );
}

/** No signal, or the Terra server is not answering. The saved login is kept. */
export function CannotReachScreen({ onRetry, detail }: { onRetry: () => Promise<unknown> | void; detail?: string | null }) {
  const [busy, setBusy] = React.useState(false);
  return (
    <Shell>
      <Title>Can't reach Terra</Title>
      <Body>Check you have signal or Wi-Fi, then try again. You are still signed in, nothing has been lost.</Body>
      {detail ? <Detail>{detail}</Detail> : null}
      <Action
        label="Try again"
        busy={busy}
        onPress={() => {
          setBusy(true);
          void Promise.resolve(onRetry()).finally(() => setBusy(false));
        }}
      />
    </Shell>
  );
}

/** Wipe the login off the phone and go back to Sign in. Works with no signal. */
export function startFresh(queryClient: QueryClient) {
  forgetLoginOnPhone();
  forgetSignedIn();
  setLoginNote("reset");
  queryClient.clear();
  // Signed out on this phone straight away, signal or not. The layout then
  // sends the person to Sign in.
  const atom = authClient.$store.atoms.session as
    | { get: () => Record<string, unknown>; set: (v: Record<string, unknown>) => void }
    | undefined;
  atom?.set({ ...atom.get(), data: null, error: null, isPending: false, isRefetching: false });
  // Tell the server too, if it can be reached. Nothing saved is sent, so this
  // only matters for a login it still remembers.
  void authClient.signOut().catch(() => undefined);
}

type BoundaryState = { error: Error | null; busy: boolean };

/**
 * Catches anything that goes wrong once the app is drawing, plus a fatal error
 * from outside a screen (see crash-guard), and shows Try again or Sign out
 * instead of closing. Either way the error is kept and sent to Ops.
 */
export class StartupBoundary extends Component<{ children: ReactNode; queryClient: QueryClient }, BoundaryState> {
  state: BoundaryState = { error: null, busy: false };

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    queueProblem({
      kind: "screen",
      message: `${error.name}: ${error.message}`,
      stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}`,
    });
  }

  componentDidMount() {
    onFatal((error) => this.setState({ error }));
  }

  componentWillUnmount() {
    onFatal(null);
  }

  private retry = () => {
    this.props.queryClient.clear();
    this.setState({ error: null });
  };

  private fresh = () => {
    this.setState({ busy: true });
    startFresh(this.props.queryClient);
    this.setState({ error: null, busy: false });
  };

  render() {
    const { error, busy } = this.state;
    if (!error) return this.props.children;
    return (
      <Shell>
        <Title>Terra hit a problem</Title>
        <Body>
          Tap Try again. If it keeps happening, tap Sign out and start fresh, then sign back in. You do not need to
          reinstall the app. Terra sends the details to the office.
        </Body>
        <Detail>{`${error.name}: ${error.message}`.slice(0, 300)}</Detail>
        <Action label="Try again" onPress={this.retry} />
        <Action label="Sign out and start fresh" quiet busy={busy} onPress={this.fresh} />
      </Shell>
    );
  }
}
