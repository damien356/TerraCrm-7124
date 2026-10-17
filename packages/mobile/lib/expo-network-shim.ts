/**
 * Stand-in for expo-network (notes 18.57).
 *
 * @better-auth/expo asks for expo-network with import() the first time the
 * login is read, to refetch the session when the phone comes back online.
 * expo-network is optional and Terra does not ship it, so the bundle had
 * nothing there and that import() threw "Cannot find module" on the phone.
 * On iPhone and Android that is a fatal error: Terra closed straight after
 * the logo. metro.config.js points expo-network here instead.
 *
 * This keeps the library's own fallback for a phone without expo-network:
 * it counts as online and never hears of a change. React Query and the
 * focus refetch still pick the session up when Terra comes to the front.
 */
type NetworkState = { isConnected?: boolean; isInternetReachable?: boolean };

export function addNetworkStateListener(_listener: (state: NetworkState) => void) {
  return { remove() {} };
}

export async function getNetworkStateAsync(): Promise<NetworkState> {
  return { isConnected: true, isInternetReachable: true };
}
