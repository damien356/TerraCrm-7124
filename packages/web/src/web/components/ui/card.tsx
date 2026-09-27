import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("card-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-border px-4 py-3", className)}>
      <div className="flex items-start gap-2.5">
        <span className="mt-[7px] h-3 w-[3px] shrink-0 rounded-full bg-[var(--gold)]" />
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
  hint?: string;
}) {
  const toneClass = {
    default: "text-foreground",
    warning: "text-[var(--warning)]",
    danger: "text-destructive",
    success: "text-[var(--success)]",
  }[tone];

  return (
    <div className="card-surface relative overflow-hidden px-4 py-3.5">
      <span className="absolute inset-x-0 top-0 h-[2px] bg-[linear-gradient(90deg,var(--gold),rgba(188,149,88,0))]" />
      <p className="label-xs">{label}</p>
      <p className={cn("tabular mt-1.5 text-[26px] font-bold leading-none tracking-[-0.02em]", toneClass)}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "size-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary",
        className,
      )}
    />
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}
