import * as React from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  BanknoteArrowDown,
  Building2,
  CalendarDays,
  ClipboardList,
  FileText,
  HardHat,
  MessagesSquare,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  MapPinned,
  PieChart,
  Receipt,
  Settings as SettingsIcon,
  Tags,
  TrendingUp,
  Truck,
  UserRoundSearch,
  Users,
  Wallet,
} from "lucide-react";
import { authClient } from "../lib/auth";
import { useBootstrap } from "../queries/settings";
import { Loading } from "./ui/card";
import { cn } from "@/lib/utils";

/**
 * The sidebar is grouped because the app does four different jobs now:
 * running the work, knowing who the customers are, watching the money, and
 * admin. Flat lists of fourteen items make you read all fourteen every time.
 *
 * Customers splits three ways deliberately. A client is a person who pays,
 * a company is the billing entity, and a contact is a person inside that
 * company who sends work. They are not the same question.
 */
const NAV: { label?: string; items: { to: string; label: string; icon: typeof Users }[] }[] = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/conversations", label: "Conversations", icon: MessagesSquare },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/schedule", label: "Schedule", icon: CalendarDays },
      { to: "/jobs", label: "Jobs", icon: ClipboardList },
      { to: "/quotes", label: "Quotes", icon: FileText },
      { to: "/crew", label: "Crew map", icon: MapPinned },
      { to: "/installers", label: "Installers", icon: HardHat },
      { to: "/products", label: "Price book", icon: Tags },
    ],
  },
  {
    label: "Customers",
    items: [
      { to: "/clients", label: "Clients", icon: Users },
      { to: "/companies", label: "Companies", icon: Building2 },
      { to: "/supervisors", label: "Supervisors", icon: UserRoundSearch },
    ],
  },
  {
    label: "Finance",
    items: [
      { to: "/finance/cashflow", label: "Cashflow", icon: Wallet },
      { to: "/finance/forecasting", label: "Forecasting", icon: TrendingUp },
      { to: "/finance/invoices", label: "Invoices", icon: Receipt },
      { to: "/finance/expenses", label: "Expenses", icon: BanknoteArrowDown },
      { to: "/suppliers", label: "Suppliers", icon: Truck },
      { to: "/finance/profitability", label: "Profitability", icon: PieChart },
    ],
  },
  {
    label: "Admin",
    items: [
      { to: "/review", label: "Import review", icon: ListChecks },
      { to: "/team", label: "Logins", icon: KeyRound },
      { to: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

function NavLink({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Users }) {
  const [location] = useLocation();
  const active = to === "/" ? location === "/" : location.startsWith(to);
  return (
    <Link
      to={to}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md px-3 py-[9px] text-[13.5px] font-medium transition-all",
        active
          ? "bg-[linear-gradient(90deg,rgba(188,149,88,0.20),rgba(188,149,88,0.04))] text-white"
          : "text-white/55 hover:bg-white/[0.06] hover:text-white/90",
      )}
    >
      {active ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-[var(--gold)]" />
      ) : null}
      <Icon className={cn("size-[17px] shrink-0", active ? "text-[var(--gold)]" : "")} />
      {label}
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [isLogin] = useRoute("/login");
  const session = authClient.useSession();
  const bootstrap = useBootstrap();

  if (isLogin) return <>{children}</>;

  if (session.isPending) return <Loading label="Loading Terra Ops…" />;

  if (!session.data) {
    window.location.href = "/login";
    return <Loading label="Redirecting to sign in…" />;
  }

  const role = bootstrap.data?.actor.role;

  // Installers work out of the mobile app — the office web app is admin-only.
  if (bootstrap.isFetched && role !== "admin") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="card-surface max-w-md px-6 py-8 text-center">
          <HardHat className="mx-auto size-8 text-primary" />
          <h1 className="mt-3 text-lg font-semibold">Field crew account</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your jobs live in the Terra Flooring installer app, not in the office system. Open the app on your
            phone to see today's work and any offers waiting for you.
          </p>
          <button
            type="button"
            onClick={() => authClient.signOut().then(() => (window.location.href = "/login"))}
            className="mt-5 text-sm font-medium text-primary hover:underline"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 flex h-screen w-[228px] shrink-0 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] px-3 py-4">
        <div className="flex items-center gap-3 px-2 pb-4">
          <img src="/images/terra-mark-reverse.png" alt="Terra Flooring" className="size-9 shrink-0" />
          <div>
            <p className="text-[15.5px] font-bold leading-tight tracking-[-0.01em] text-white">Terra Ops</p>
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--gold)]">
              Terra Flooring
            </p>
          </div>
        </div>
        <div className="gold-rule mb-3.5" />
        <nav className="board-scroll flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {NAV.map((group, i) => (
            <div key={group.label ?? `top-${i}`} className={group.label ? "mt-3" : ""}>
              {group.label ? (
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/30">
                  {group.label}
                </p>
              ) : null}
              <div className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <NavLink key={item.to} {...item} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 pt-3">
          <p className="truncate px-3 text-xs font-medium text-white/80">
            {bootstrap.data?.actor.name || session.data.user.name || "Office"}
          </p>
          <p className="truncate px-3 text-[11px] text-white/40">{session.data.user.email}</p>
          <button
            type="button"
            onClick={() => authClient.signOut().then(() => (window.location.href = "/login"))}
            className="mt-2 flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs font-medium text-white/50 transition-colors hover:bg-white/5 hover:text-white/90"
          >
            <LogOut className="size-3.5" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

/** Standard page frame: title row + content, used by every admin page. */
export function Page({
  title,
  subtitle,
  actions,
  children,
  wide,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div>
      <div className="page-chrome px-6 py-4">
        <div className={cn("flex flex-wrap items-end justify-between gap-3", wide ? "" : "mx-auto max-w-[1400px]")}>
          <div>
            <h1 className="page-title">{title}</h1>
            {subtitle ? <p className="page-sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
      <div className={cn("px-6 py-5", wide ? "" : "mx-auto max-w-[1400px]")}>{children}</div>
    </div>
  );
}
