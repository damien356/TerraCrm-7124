import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A YYYY-MM-DD day as DD/MM/YYYY (notes 18.52). Anything that is not one comes
 * back as it was, so it is safe on text the server already wrote out.
 */
/**
 * YYYY-MM-DD on this computer's calendar (notes 18.61). toISOString is the UTC
 * day, which is yesterday on the Gold Coast until 10 am, and for a local
 * midnight it is always the day before.
 */
export function localYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * A date picker value. A plain YYYY-MM-DD comes back as it is; a timestamp is
 * read on this computer's calendar, not in UTC (notes 18.61).
 */
export function dayOf(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? "" : localYmd(d);
}

export function auDay(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/^(\d{4})-(\d{2})-(\d{2})(?![\d])/, (_m, y: string, mo: string, d: string) => `${d}/${mo}/${y}`);
}
