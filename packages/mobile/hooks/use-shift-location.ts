import { useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { usePingLocation } from "@/queries/field";

/**
 * ON-SHIFT LOCATION. Reports a position to the office every couple of minutes
 * while a job is actually running, and stops dead the moment it isn't.
 *
 * Three gates, all of which must be true:
 *   1. the installer switched sharing on themselves (Me screen),
 *   2. the task passed in is in progress right now,
 *   3. the phone granted foreground location permission.
 *
 * There is no background tracking, no after-hours polling, and the server
 * rejects any ping that arrives outside a running job anyway.
 */

const EVERY_MS = 120_000;

type ShiftState = "off" | "no_permission" | "sharing" | "error";

export function useShiftLocation({
  taskId,
  running,
  consented,
}: {
  taskId: number;
  running: boolean;
  consented: boolean;
}) {
  const ping = usePingLocation();
  const [state, setState] = useState<ShiftState>("off");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };

    if (!running || !consented || !Number.isFinite(taskId)) {
      stop();
      setState("off");
      return () => {
        cancelled = true;
        stop();
      };
    }

    const send = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;
        await ping.mutateAsync({
          taskId,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          speed: pos.coords.speed != null ? Math.max(0, pos.coords.speed * 3.6) : null,
        });
        if (!cancelled) setState("sharing");
      } catch {
        if (!cancelled) setState("error");
      } finally {
        busy.current = false;
      }
    };

    void (async () => {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (!granted) {
        setState("no_permission");
        return;
      }
      await send();
      if (cancelled) return;
      timer.current = setInterval(() => void send(), EVERY_MS);
    })();

    return () => {
      cancelled = true;
      stop();
    };
    // `ping` is a stable mutation object from react-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, running, consented]);

  return state;
}
