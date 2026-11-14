/**
 * LINKS FROM THE HOME-SCREEN WIDGETS (Damien, 14 Nov 2026).
 *
 * Every link that opens Terra passes through here first. Most go straight
 * on unchanged (sign-in callbacks included). Two get a fresh "at" stamp, so
 * tapping the same widget line twice still does something:
 *  - Office links, because the Office tab only moves its page when asked again.
 *  - Directions, because the job screen opens maps once per tap.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    const wantsStamp = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\/?office(?:[/?#]|$)/i.test(path) || /[?&]go=directions(?:&|#|$)/.test(path);
    if (!wantsStamp) return path;
    const [head, hash = ""] = path.split("#", 2);
    const stamped = `${head}${head.includes("?") ? "&" : "?"}at=${Date.now()}`;
    return hash ? `${stamped}#${hash}` : stamped;
  } catch {
    return path;
  }
}
