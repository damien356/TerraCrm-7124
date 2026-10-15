/**
 * Phone mode (notes 18.44). The Terra phone app shows these office pages
 * inside itself for Admin and Office logins. When it does, the menu is cut
 * down to what Damien wants on a phone, the schedule board is view only and
 * quote prices are read only. The website in a normal browser never sees any
 * of this.
 *
 * The app marks itself three ways, any one is enough: a flag it injects
 * before the page loads, "?app=1" on the first address it opens (kept for the
 * rest of that session) and "TerraOpsApp/" on the end of its user agent.
 */

const SESSION_KEY = "terra-ops.phone-app";

/** Sent on every API call from phone mode, so the server holds the same lines. */
export const PHONE_APP_HEADER = "x-terra-app";
export const PHONE_APP_VALUE = "phone";

function detect(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if ((window as unknown as { __TERRA_PHONE_APP__?: boolean }).__TERRA_PHONE_APP__ === true) return true;
    const param = new URLSearchParams(window.location.search).get("app");
    if (param === "1") {
      sessionStorage.setItem(SESSION_KEY, "1");
      return true;
    }
    if (param === "0") {
      sessionStorage.removeItem(SESSION_KEY);
      return false;
    }
    if (sessionStorage.getItem(SESSION_KEY) === "1") return true;
    return /TerraOpsApp\//.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** Worked out once when the page loads. A reload inside the app keeps it. */
export const isPhoneApp = detect();
