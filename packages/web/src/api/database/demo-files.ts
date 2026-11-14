import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { putObject } from "../lib/s3";

/**
 * The store reviewer's plan and room photos (Damien, 14 Nov 2026).
 *
 * Google Play wants real screens of the app in use, so the demo job carries a
 * floor plan and four photos. The plan is drawn for the demo and the photos
 * are free Pexels stock of empty carpeted rooms, no people and no addresses.
 * They live in public/demo-assets and are copied to storage under
 * demo/seed/ the first time the demo is built in each server run. The demo
 * database itself is rebuilt every day, the files are not.
 *
 * Nothing here can stop the demo being built. A file that can't be read or
 * stored is left out and the rest of the demo carries on without it.
 */

export type DemoFile = { name: string; bucket: "plan" | "area"; mime: string; caption: string };

export const DEMO_FILES: DemoFile[] = [
  { name: "plan-9218.png", bucket: "plan", mime: "image/png", caption: "Carpet layout, 68 m2" },
  { name: "bed-1.jpg", bucket: "area", mime: "image/jpeg", caption: "Bed 1 before the uplift" },
  { name: "bed-2.jpg", bucket: "area", mime: "image/jpeg", caption: "Bed 2 before the uplift" },
  { name: "bed-3.jpg", bucket: "area", mime: "image/jpeg", caption: "Bed 3 before the uplift" },
  { name: "bed-3-robe.jpg", bucket: "area", mime: "image/jpeg", caption: "Bed 3, robe side" },
];

/** Always under demo/, so it can never land on or be read as a real file. */
export const demoFileKey = (name: string) => `demo/seed/${name}`;

/** Where the files can be on disk: running from source, or from a build. */
function candidates(name: string) {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return [
    join(here, "../../../public/demo-assets", name),
    join(process.cwd(), "public/demo-assets", name),
    join(process.cwd(), "packages/web/public/demo-assets", name),
    join(process.cwd(), "dist/demo-assets", name),
    join(here, "../../../dist/demo-assets", name),
  ];
}

async function bytesOf(name: string): Promise<Buffer | null> {
  for (const path of candidates(name)) {
    try {
      return await readFile(path);
    } catch {
      /* try the next place */
    }
  }
  /* Last try: the copy the website serves. */
  const site = process.env.WEBSITE_URL;
  if (!site) return null;
  try {
    const res = await fetch(`${site.replace(/\/+$/, "")}/demo-assets/${name}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Names already in storage during this server run, with their size. */
const stored = new Map<string, number>();

/**
 * Make sure each demo file is in storage. Returns the ones that are, by name,
 * with their size in bytes. Called while the demo is built, so it is capped
 * at a few seconds in total and never throws.
 */
export async function loadDemoFiles(): Promise<Map<string, number>> {
  const deadline = Date.now() + 15_000;
  await Promise.all(
    DEMO_FILES.filter((f) => !stored.has(f.name)).map(async (f) => {
      try {
        const body = await bytesOf(f.name);
        if (!body) {
          console.error(`[play-demo] ${f.name} not found, left out of the demo`);
          return;
        }
        await putObject(demoFileKey(f.name), body, f.mime, undefined, { timeoutMs: 8000, retries: 1, deadline });
        stored.set(f.name, body.length);
      } catch (e) {
        console.error(`[play-demo] could not store ${f.name}, left out of the demo`, e instanceof Error ? e.message : e);
      }
    }),
  );
  return new Map(stored);
}

/** Tests only: forget what was stored. */
export function resetDemoFiles() {
  stored.clear();
}
