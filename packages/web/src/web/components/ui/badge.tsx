import * as React from "react";
import { cn } from "@/lib/utils";

/** Neutral pill. Pass `colour` (hex from the DB) for status-driven tinting. */
export function Badge({
  children,
  colour,
  className,
}: {
  children: React.ReactNode;
  colour?: string | null;
  className?: string;
}) {
  if (colour) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-tight",
          className,
        )}
        style={{ backgroundColor: `${colour}1F`, color: colour }}
      >
        {children}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium leading-tight text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Task status → colour, matching the design contract. */
export const TASK_STATUS_COLOUR: Record<string, string> = {
  unassigned: "#C0603F",
  offered: "#D08A1E",
  assigned: "#4A7FA5",
  in_progress: "#D08A1E",
  complete: "#3F7D3A",
  cancelled: "#7A736D",
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  unassigned: "Unassigned",
  offered: "Offered",
  assigned: "Assigned",
  in_progress: "In progress",
  complete: "Complete",
  cancelled: "Cancelled",
};

/** Skill group → board tint (soft fill + solid left edge). */
export const SKILL_TINT: Record<string, { fill: string; edge: string }> = {
  carpet: { fill: "#DCE8F2", edge: "#4A7FA5" },
  resilient: { fill: "#E2EFDF", edge: "#5C8A52" },
  timber: { fill: "#F5E8D8", edge: "#B07B3A" },
  prep: { fill: "#EDE9E4", edge: "#7A736D" },
  demolition: { fill: "#F7E2DE", edge: "#C0603F" },
  trades: { fill: "#EDE4F2", edge: "#7A6A9E" },
  other: { fill: "#EFECE8", edge: "#7A736D" },
};

export function tintFor(group?: string | null) {
  return SKILL_TINT[group ?? "other"] ?? SKILL_TINT.other;
}
