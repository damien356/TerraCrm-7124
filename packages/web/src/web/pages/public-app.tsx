import * as React from "react";
import { Smartphone } from "lucide-react";
import { Spinner } from "../components/ui/card";
import { PublicCard, PublicMessage, PublicShell } from "../components/public-shell";
import { usePublicAppLinks } from "../queries/invites";

/**
 * /app: the download link in every staff invite (notes 18.55). No login.
 * On an iPhone it goes straight to the iPhone link, on Android to the
 * Android link. On a computer, or anything else, it shows both.
 * The links themselves are set by an Admin in Settings, Staff app.
 */

type Device = "ios" | "android" | "other";

function detect(): Device {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  /* iPads ask for the desktop site and say Macintosh. They have a touch screen, Macs don't. */
  if (/macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1) return "ios";
  return "other";
}

const OFFICE = "1300 183 772";

function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[var(--gold)] px-5 text-sm font-semibold text-white shadow-sm hover:brightness-95"
    >
      <Smartphone className="size-4" />
      {children}
    </a>
  );
}

export default function PublicAppPage() {
  const links = usePublicAppLinks();
  const device = React.useMemo(detect, []);
  const target = links.data ? (device === "ios" ? links.data.ios : device === "android" ? links.data.android : "") : "";

  React.useEffect(() => {
    if (target) window.location.replace(target);
  }, [target]);

  if (links.isLoading) {
    return (
      <PublicShell>
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </PublicShell>
    );
  }

  const ios = links.data?.ios ?? "";
  const android = links.data?.android ?? "";

  if (target) {
    return (
      <PublicShell>
        <PublicMessage title="Opening the download">
          <p className="mb-4">If nothing happens, tap the button.</p>
          <LinkButton href={target}>{device === "ios" ? "Get the Terra app for iPhone" : "Get the Terra app for Android"}</LinkButton>
        </PublicMessage>
      </PublicShell>
    );
  }

  if (!ios && !android) {
    return (
      <PublicShell>
        <PublicMessage title="The download link is not ready yet">
          Call the office on {OFFICE} and they'll send it to you.
        </PublicMessage>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <PublicCard title="Get the Terra app">
        <p className="mb-4 text-sm text-muted-foreground">
          {device === "other"
            ? "Open this page on your phone, or use the link for your phone below."
            : `The link for your phone is not ready yet. Call the office on ${OFFICE}.`}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {ios ? (
            <div className="space-y-1.5">
              <LinkButton href={ios}>iPhone</LinkButton>
              <p className="break-all text-center text-[11px] text-muted-foreground">{ios}</p>
            </div>
          ) : null}
          {android ? (
            <div className="space-y-1.5">
              <LinkButton href={android}>Android</LinkButton>
              <p className="break-all text-center text-[11px] text-muted-foreground">{android}</p>
            </div>
          ) : null}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Any questions, call the office on {OFFICE}.</p>
      </PublicCard>
    </PublicShell>
  );
}
