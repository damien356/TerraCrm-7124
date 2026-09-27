import { Redirect } from "expo-router";

/** The managed-auth broker deep-links back here. Bounce straight to Today. */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
