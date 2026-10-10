import * as React from "react";
import L from "leaflet";
import { MapPin, Navigation, RefreshCw, ShieldOff } from "lucide-react";
import { Page } from "../components/layout";
import { Button } from "../components/ui/button";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { useCrewSharing, useCrewTrail, useLiveCrew, useOnShift } from "../queries/crew";

/** Gold Coast — where the map sits when nobody's on the clock. */
const HOME: [number, number] = [-28.0167, 153.4];

type Pin = {
  installerId: number;
  installerName: string;
  installerColour: string;
  lat: number;
  lng: number;
  capturedAt: Date | string;
  taskTitle: string | null;
  jobNumber: string | null;
  siteSuburb: string | null;
};

function minutesAgo(at: Date | string | null | undefined) {
  if (!at) return null;
  const ms = Date.now() - new Date(at).getTime();
  return Math.max(0, Math.round(ms / 60_000));
}

function agoLabel(at: Date | string | null | undefined) {
  const m = minutesAgo(at);
  if (m === null) return "-";
  if (m < 1) return "just now";
  if (m === 1) return "1 min ago";
  if (m < 60) return `${m} mins ago`;
  const h = Math.floor(m / 60);
  return h === 1 ? "1 hr ago" : `${h} hrs ago`;
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The map. Leaflet driven straight off the DOM — no avatars, no cartoon
 * figures, just a coloured chip per installer with their initials.
 */
function CrewMap({
  pins,
  trail,
  focus,
  onFocus,
}: {
  pins: Pin[];
  trail: { lat: number; lng: number }[];
  focus: number | null;
  onFocus: (id: number) => void;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const map = React.useRef<L.Map | null>(null);
  const layer = React.useRef<L.LayerGroup | null>(null);
  const line = React.useRef<L.Polyline | null>(null);

  React.useEffect(() => {
    if (!host.current || map.current) return;
    const m = L.map(host.current, { zoomControl: true, attributionControl: true }).setView(HOME, 11);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 19,
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layer.current = null;
      line.current = null;
    };
  }, []);

  // Pins.
  React.useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    group.clearLayers();

    for (const p of pins) {
      const stale = (minutesAgo(p.capturedAt) ?? 0) > 15;
      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "crew-pin",
          html: `<span class="crew-pin-chip" style="background:${p.installerColour};opacity:${stale ? 0.55 : 1}">${initials(
            p.installerName,
          )}</span>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      }).addTo(group);
      marker.bindTooltip(
        `<strong>${p.installerName}</strong><br/>${p.taskTitle ?? "On a job"}${
          p.siteSuburb ? `, ${p.siteSuburb}` : ""
        }<br/>${agoLabel(p.capturedAt)}`,
        { direction: "top", offset: [0, -14] },
      );
      marker.on("click", () => onFocus(p.installerId));
    }

    if (pins.length > 0) {
      const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]));
      m.fitBounds(bounds.pad(0.35), { maxZoom: 14, animate: false });
    }
  }, [pins, onFocus]);

  // Breadcrumb trail for the focused installer.
  React.useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (line.current) {
      line.current.remove();
      line.current = null;
    }
    if (focus === null || trail.length < 2) return;
    line.current = L.polyline(
      trail.map((t) => [t.lat, t.lng] as [number, number]),
      { color: "#BC9558", weight: 3, opacity: 0.8, dashArray: "6 5" },
    ).addTo(m);
  }, [focus, trail]);

  return <div ref={host} className="h-[560px] w-full rounded-lg" />;
}

export default function CrewPage() {
  const live = useLiveCrew();
  const shift = useOnShift();
  const sharing = useCrewSharing();
  const [focus, setFocus] = React.useState<number | null>(null);
  const trail = useCrewTrail(focus);

  const pins = (live.data ?? []) as unknown as Pin[];
  const onShift = shift.data ?? [];
  const notSharing = onShift.filter((r) => !r.sharing);
  const sharingOn = (sharing.data ?? []).filter((s) => s.consentAt).length;

  return (
    <Page
      title="Crew map"
      subtitle="Where the crew are, while they're on a job. Nothing is tracked outside a running job."
      actions={
        <Button
          variant="outline"
          onClick={() => {
            live.refetch();
            shift.refetch();
          }}
          disabled={live.isFetching}
        >
          <RefreshCw className={live.isFetching ? "animate-spin" : ""} />
          Refresh
        </Button>
      }
      wide
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="overflow-hidden p-1">
          {live.isLoading ? (
            <Loading label="Finding the crew…" />
          ) : pins.length === 0 ? (
            <div className="flex h-[560px] flex-col items-center justify-center gap-2 text-center">
              <MapPin className="size-7 text-muted-foreground" />
              <p className="text-sm font-medium">Nobody's on the clock right now</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Pins only appear while an installer has a job running in the app, and only if they've switched
                sharing on. The map clears itself when the last job is marked complete.
              </p>
            </div>
          ) : (
            <CrewMap pins={pins} trail={trail.data ?? []} focus={focus} onFocus={setFocus} />
          )}
        </Card>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Stat label="On a job" value={onShift.length} />
            <Stat label="Sharing on" value={sharingOn} hint={`of ${(sharing.data ?? []).length} crew`} />
          </div>

          <Card>
            <CardHeader title="On the clock" subtitle="Jobs running right now" />
            {shift.isLoading ? (
              <Loading />
            ) : onShift.length === 0 ? (
              <Empty>Nobody has started a job yet today.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {onShift.map((r) => {
                  const pin = pins.find((p) => p.installerId === r.installerId);
                  return (
                    <li key={r.taskId}>
                      <button
                        type="button"
                        onClick={() => setFocus(r.installerId)}
                        className={
                          "flex w-full items-start gap-2.5 px-4 py-3 text-left transition-colors hover:bg-accent" +
                          (focus === r.installerId ? " bg-accent" : "")
                        }
                      >
                        <span
                          className="mt-0.5 size-2.5 shrink-0 rounded-full"
                          style={{ background: r.installerColour }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{r.installerName}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {r.taskTitle}
                            {r.siteSuburb ? `, ${r.siteSuburb}` : ""}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {r.sharing
                              ? pin
                                ? `Last seen ${agoLabel(pin.capturedAt)}`
                                : "Sharing on, waiting for first position"
                              : "Sharing off, no position"}
                          </span>
                        </span>
                        {r.sharing ? (
                          <Navigation className="size-4 shrink-0 text-[var(--gold)]" />
                        ) : (
                          <ShieldOff className="size-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {notSharing.length > 0 ? (
            <Card className="border-[var(--warning)]/40 bg-[var(--gold-wash)]">
              <div className="px-4 py-3">
                <p className="label-xs">Sharing switched off</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {notSharing.map((r) => r.installerName).join(", ")} {notSharing.length === 1 ? "has" : "have"} a
                  job running but location sharing turned off. It's their switch, in the app under Me. The office
                  can't turn it on for them.
                </p>
              </div>
            </Card>
          ) : null}

          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            Positions are recorded only between "Start job" and "Mark complete", roughly every two minutes, and
            drop off this map after 45 minutes of silence. History is kept 14 days, then deleted.
          </p>
        </div>
      </div>
    </Page>
  );
}
