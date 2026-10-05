import * as React from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  BanknoteArrowDown,
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  HandCoins,
  HardHat,
  MessagesSquare,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Mail,
  MapPinned,
  ShieldCheck,
  Menu,
  Mic,
  PieChart,
  Receipt,
  Settings as SettingsIcon,
  Sparkles,
  Tags,
  TrendingUp,
  Truck,
  UserRoundSearch,
  Users,
  Wallet,
  Workflow,
  X,
} from "lucide-react";
import { authClient } from "../lib/auth";
import { useBootstrap } from "../queries/settings";
import { Loading } from "./ui/card";
import { GlobalMemoButton, MemoProvider } from "./voice-memo";
import { DueReminders } from "./office-tasks";
import { cn } from "@/lib/utils";

type NavIcon = typeof Users;

type NavLeaf = { to: string; label: string; icon: NavIcon };
type NavSection = { label: string; icon: NavIcon; children: NavLeaf[] };
type NavEntry = NavLeaf | NavSection;

function isSection(entry: NavEntry): entry is NavSection {
  return "children" in entry;
}

/**
 * Ten top-level areas, locked. Anything new belongs inside one of them rather
 * than as an eleventh line in the sidebar.
 *
 * Sections with children stay collapsed until you are inside them, so the
 * first thing a new office user reads is ten words, not thirty.
 *
 * Customers splits three ways deliberately. A client is a person who pays,
 * a company is the billing entity, and a supervisor is a person inside that
 * company who sends work. They are not the same question.
 *
 * Installers and Price Book sit in Admin because they are configuration you
 * set up once and then read from everywhere, not screens you work in daily.
 */
const NAV: NavEntry[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/conversations", label: "Conversations", icon: MessagesSquare },
  {
    label: "Pipeline",
    icon: Workflow,
    children: [
      { to: "/quotes", label: "Quotes", icon: FileText },
      { to: "/voice-quotes", label: "Voice drafts", icon: Mic },
    ],
  },
  { to: "/jobs", label: "Jobs", icon: ClipboardList },
  {
    label: "Schedule",
    icon: CalendarDays,
    children: [
      { to: "/schedule", label: "Board", icon: CalendarDays },
      { to: "/crew", label: "Crew map", icon: MapPinned },
      { to: "/safety", label: "SWMS and SDS", icon: ShieldCheck },
    ],
  },
  {
    label: "Customers",
    icon: Users,
    children: [
      { to: "/clients", label: "Clients", icon: Users },
      { to: "/companies", label: "Companies", icon: Building2 },
      { to: "/supervisors", label: "Supervisors", icon: UserRoundSearch },
    ],
  },
  {
    label: "Finance",
    icon: Wallet,
    children: [
      { to: "/finance/cashflow", label: "Cashflow", icon: Wallet },
      { to: "/finance/forecasting", label: "Forecasting", icon: TrendingUp },
      { to: "/finance/invoices", label: "Invoices", icon: Receipt },
      { to: "/finance/subcontractor-invoices", label: "Installer invoices", icon: HardHat },
      { to: "/finance/expenses", label: "Expenses", icon: BanknoteArrowDown },
      { to: "/finance/suppliers-owed", label: "Suppliers owed", icon: HandCoins },
      { to: "/suppliers", label: "Suppliers", icon: Truck },
      { to: "/finance/profitability", label: "Profitability", icon: PieChart },
    ],
  },
  {
    label: "Marketing",
    icon: Mail,
    children: [
      { to: "/marketing/templates", label: "Email templates", icon: Mail },
      { to: "/marketing/segments", label: "Segments", icon: Users },
    ],
  },
  { to: "/terra-ai", label: "Terra AI", icon: Sparkles },
  {
    label: "Admin",
    icon: SettingsIcon,
    children: [
      { to: "/settings", label: "Settings", icon: SettingsIcon },
      { to: "/installers", label: "Installers", icon: HardHat },
      { to: "/products", label: "Price book", icon: Tags },
      { to: "/team", label: "Logins", icon: KeyRound },
      { to: "/review", label: "Import review", icon: ListChecks },
    ],
  },
];

/**
 * Prefix match on a path boundary, so /quotes lights up for /quotes/12 but
 * /finance/invoices never lights up for /finance/subcontractor-invoices.
 */
function matches(location: string, to: string) {
  if (to === "/") return location === "/";
  return location === to || location.startsWith(`${to}/`);
}

function NavLink({
  to,
  label,
  icon: Icon,
  nested,
  onNavigate,
}: NavLeaf & { nested?: boolean; onNavigate?: () => void }) {
  const [location] = useLocation();
  const active = matches(location, to);
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={cn(
        "relative flex items-center gap-2.5 rounded-md py-[9px] text-[13.5px] font-medium transition-all",
        nested ? "pl-8 pr-3" : "px-3",
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

function NavGroup({ section, onNavigate }: { section: NavSection; onNavigate?: () => void }) {
  const [location] = useLocation();
  const holdsLocation = section.children.some((child) => matches(location, child.to));
  const [open, setOpen] = React.useState(holdsLocation);

  // Following a link into a section opens it, and it stays open once you are
  // in there. Closing it by hand is still allowed.
  React.useEffect(() => {
    if (holdsLocation) setOpen(true);
  }, [holdsLocation]);

  const Icon = section.icon;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "relative flex w-full items-center gap-2.5 rounded-md px-3 py-[9px] text-[13.5px] font-medium transition-all",
          holdsLocation ? "text-white" : "text-white/55 hover:bg-white/[0.06] hover:text-white/90",
        )}
      >
        <Icon className={cn("size-[17px] shrink-0", holdsLocation ? "text-[var(--gold)]" : "")} />
        <span className="flex-1 text-left">{section.label}</span>
        <Chevron className="size-3.5 shrink-0 text-white/35" />
      </button>
      {open ? (
        <div className="mt-0.5 flex flex-col gap-0.5">
          {section.children.map((child) => (
            <NavLink key={child.to} {...child} nested onNavigate={onNavigate} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [isLogin] = useRoute("/login");
  const session = authClient.useSession();
  const bootstrap = useBootstrap();
  const [location] = useLocation();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // A link tapped inside the drawer should leave you looking at the page.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [location]);

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

  const sidebar = (
    <>
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
        {NAV.map((entry) =>
          isSection(entry) ? (
            <NavGroup key={entry.label} section={entry} onNavigate={() => setDrawerOpen(false)} />
          ) : (
            <NavLink key={entry.to} {...entry} onNavigate={() => setDrawerOpen(false)} />
          ),
        )}
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
    </>
  );

  return (
    <MemoProvider>
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen w-[228px] shrink-0 flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] px-3 py-4 lg:flex">
        {sidebar}
      </aside>

      {/* Narrow screens get the same nav behind a hamburger rather than a squeezed rail. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <aside className="relative flex h-full w-[264px] max-w-[85vw] flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] px-3 py-4">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-3 top-4 rounded-md p-1.5 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-[var(--sidebar-border)] bg-[var(--sidebar)] px-4 py-2.5 lg:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
          >
            <Menu className="size-5" />
          </button>
          <img src="/images/terra-mark-reverse.png" alt="Terra Flooring" className="size-7 shrink-0" />
          <p className="text-[14px] font-bold tracking-[-0.01em] text-white">Terra Ops</p>
        </div>
        <main className="min-w-0 flex-1 pb-20">{children}</main>
      </div>
      {/* Voice memo from anywhere: say who and what, it works out the rest. */}
      <GlobalMemoButton />
      <DueReminders />
    </div>
    </MemoProvider>
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
