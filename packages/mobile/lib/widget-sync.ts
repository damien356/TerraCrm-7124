import { Platform } from "react-native";
import { requestWidgetUpdate } from "react-native-android-widget";
import { client } from "./api";
import {
  myJobView,
  signedOutJob,
  signedOutToday,
  timelineMoments,
  todayView,
  type WidgetCache,
} from "./widget-model";
import { cachedAccount, clearCache, readCache, writeCache } from "./widget-store";
// Loading this file registers the iPhone widgets, so it is imported early by
// app/_layout.tsx. Until the app has run once, the iPhone has no layout to draw.
import { myJobWidget, terraTodayWidget } from "../widgets/ios-widgets";
import { ANDROID_WIDGETS, MyJobAndroid, TerraTodayAndroid } from "../widgets/android-widgets";

/**
 * KEEPING THE HOME-SCREEN WIDGETS UP TO DATE (Damien, 14 Nov 2026).
 *
 * The widgets never ask the server themselves. Each time Terra syncs (sign
 * in, and every time it comes back to the front) it fetches widget.snapshot,
 * keeps it on the phone for this login only, and redraws both widgets from
 * that copy. So the widget is as fresh as the last time Terra was opened,
 * and says when that was.
 *
 *  - Signed out, switched off, or a different person signs in: the copy is
 *    wiped and both widgets say "Open Terra to sign in".
 *  - No signal or Terra down: the old copy stays, marked "Not refreshed
 *    since", until it is too old and the widget asks to open Terra.
 *  - A job he can no longer see: it comes off the widget straight away.
 */

const android = Platform.OS === "android";
const ios = Platform.OS === "ios";
const native = android || ios;

/** Draw both widgets from this copy (or signed out, when there is none). */
export async function renderWidgets(cache: WidgetCache | null) {
  if (!native) return;
  const now = Date.now();
  try {
    if (ios) {
      if (!cache) {
        terraTodayWidget?.updateTimeline([{ date: new Date(now), props: signedOutToday() }]);
        myJobWidget?.updateTimeline([{ date: new Date(now), props: signedOutJob() }]);
      } else {
        // One entry for each moment the words change, so the widget moves on
        // to the next booking (and to "Open Terra to refresh") with Terra shut.
        const moments = timelineMoments(cache, now);
        terraTodayWidget?.updateTimeline(moments.map((t) => ({ date: new Date(t), props: todayView(cache, t) })));
        myJobWidget?.updateTimeline(moments.map((t) => ({ date: new Date(t), props: myJobView(cache, t) })));
      }
    }
    if (android) {
      await requestWidgetUpdate({
        widgetName: ANDROID_WIDGETS.today,
        renderWidget: (info) => TerraTodayAndroid(todayView(cache, Date.now()), info),
      });
      await requestWidgetUpdate({
        widgetName: ANDROID_WIDGETS.job,
        renderWidget: (info) => MyJobAndroid(myJobView(cache, Date.now()), info),
      });
    }
  } catch {
    // A widget that cannot be redrawn must never take the app down.
  }
}

/** Wipe this phone's widget copy and show "Open Terra to sign in". */
export async function clearWidgets() {
  if (!native) return;
  await clearCache().catch(() => undefined);
  await renderWidgets(null);
}

let running: Promise<void> | null = null;

/**
 * Fetch a fresh copy for the person signed in and redraw. Safe to call often:
 * calls made while one is already running share it.
 */
export function syncWidgets(signedInAs: string) {
  if (!native) return Promise.resolve();
  if (running) return running;
  running = doSync(signedInAs).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(signedInAs: string) {
  // Someone else's copy is never shown, not even for a moment.
  const had = await cachedAccount().catch(() => null);
  if (had && had !== signedInAs) await clearWidgets();

  try {
    const snap = await client.widget.snapshot();
    if (snap.accountId !== signedInAs) {
      await clearWidgets();
      return;
    }
    const cache: WidgetCache = { snap, failedAt: null };
    await writeCache(cache);
    await renderWidgets(cache);
  } catch (err) {
    const status = (err as { status?: number } | null)?.status;
    if (status === 401 || status === 403) {
      await clearWidgets();
      return;
    }
    // No signal, Terra down, or the site not published yet: keep what we had
    // and let the widget say it has not refreshed.
    const old = await readCache().catch(() => null);
    if (old && old.snap.accountId === signedInAs) {
      const marked: WidgetCache = { ...old, failedAt: Date.now() };
      await writeCache(marked).catch(() => undefined);
      await renderWidgets(marked);
    } else {
      await renderWidgets(null);
    }
  }
}

/**
 * A job this person can no longer open (taken off it, or deleted). Take it
 * off the widget now, then fetch a fresh copy.
 */
export async function forgetWidgetTask(taskId: number, signedInAs: string | null) {
  if (!native) return;
  const old = await readCache().catch(() => null);
  if (old) {
    const keep = <T extends { taskId: number }>(items: T[]) => items.filter((it) => it.taskId !== taskId);
    const { snap } = old;
    const next: WidgetCache = {
      ...old,
      snap: {
        ...snap,
        office: snap.office ? { ...snap.office, items: keep(snap.office.items) } : snap.office,
        crew: snap.crew
          ? {
              ...snap.crew,
              items: keep(snap.crew.items),
              session: snap.crew.session?.taskId === taskId ? null : snap.crew.session,
            }
          : snap.crew,
      },
    };
    await writeCache(next).catch(() => undefined);
    await renderWidgets(next);
  }
  if (signedInAs) void syncWidgets(signedInAs);
}

/** Redraw from the saved copy without asking the server (Android background redraws). */
export async function renderFromCache() {
  await renderWidgets(await readCache().catch(() => null));
}
