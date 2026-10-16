import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A YYYY-MM-DD day as DD/MM/YYYY (notes 18.52). Anything that is not one comes
 * back as it was, so it is safe on text the server already wrote out.
 */
export function auDay(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/^(\d{4})-(\d{2})-(\d{2})(?![\d])/, (_m, y: string, mo: string, d: string) => `${d}/${mo}/${y}`);
}
