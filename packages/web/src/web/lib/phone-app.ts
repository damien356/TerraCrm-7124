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

/**
 * The app draws its own menu button in its "The office" bar (app build 12 on).
 * Then the website's own Terra Ops bar is left off, so there is one header.
 * An older app build does not set this and keeps the website's bar.
 */
export const hasAppMenu =
  isPhoneApp && typeof window !== "undefined" && (window as unknown as { __TERRA_APP_MENU__?: boolean }).__TERRA_APP_MENU__ === true;

/**
 * Phone mode fits the page to the phone (Damien, 16 Oct): no pinch zoom, no
 * zooming out, no sideways scroll. The `phone-app` class on the page turns on
 * the phone styles in styles.css; the website in a browser never gets it.
 */
function applyPhoneChrome() {
  if (!isPhoneApp || typeof document === "undefined") return;
  try {
    document.documentElement.classList.add("phone-app");
    if (hasAppMenu) document.documentElement.classList.add("phone-app-menu");
    let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.appendChild(meta);
    }
    meta.content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
    /* iOS still pinches on some builds without this. */
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("gesturestart", stop, { passive: false });
    document.addEventListener("gesturechange", stop, { passive: false });
  } catch {
    /* Never stop the page loading over this. */
  }
}
applyPhoneChrome();
