import * as React from "react";
import { Download, HardDriveDownload, Plus, Search } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge, SKILL_TINT } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Label, Select } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { downloadText, useDatasets, useExportCsv, useExportSnapshot } from "../queries/backups";
import { LabourRatesTab, RATE_UNITS, UNIT_LABEL } from "../components/labour";
import { EmailAgentCard } from "../components/email-agent";
import { useOpeningBalance, useSetOpeningBalance } from "../queries/finance";
import { longDate, moneyExact } from "../lib/money";
import {
  useBootstrap,
  useCreateProduct,
  useCreateSkill,
  useCreateStatus,
  useProducts,
  useSetSetting,
  useUpdateProduct,
  useUpdateSkill,
  useUpdateStatus,
} from "../queries/settings";
import { useCreateSupplier, useSuppliers } from "../queries/suppliers";

const SKILL_GROUPS = Object.keys(SKILL_TINT);
/**
 * The stage codes the server actually reads (dashboard, cashflow, finance,
 * intel). This list used to offer "lead" and miss "won" and "active", so the
 * Won and In Progress rows showed "lead" while the data held the right code.
 */
const STAGES: { code: string; label: string; meaning: string }[] = [
  { code: "open", label: "Lead or quoting", meaning: "Counts as a lead on the dashboard. Cashflow treats it as pipeline, maybe money." },
  { code: "won", label: "Won", meaning: "Customer said yes. Cashflow counts it as expected money." },
  { code: "scheduled", label: "Booked in", meaning: "Has a date. Counts in Scheduled on the dashboard and as committed money." },
  { code: "active", label: "On site", meaning: "Work underway. Counts in Scheduled on the dashboard and as committed money." },
  { code: "complete", label: "Done", meaning: "Work finished, money still to come in. Counts as committed and as delivered work." },
  { code: "closed", label: "Closed", meaning: "Paid or cancelled. Off the open jobs list and out of cashflow." },
];
const STAGE_CODES = STAGES.map((s) => s.code);

function StageOptions({ current }: { current?: string }) {
  return (
    <>
      {current && !STAGE_CODES.includes(current) ? <option value={current}>{current} (not used)</option> : null}
      {STAGES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.label}
        </option>
      ))}
    </>
  );
}

function StageGuide() {
  const [open, setOpen] = React.useState(false);
  return (
    <Card className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span>
          <span className="block text-sm font-medium text-foreground">What the Stage does</span>
          <span className="block text-xs text-muted-foreground">
            The status name is your wording. The stage is what the system counts it as.
          </span>
        </span>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {STAGES.map((s) => (
            <div key={s.code} className="px-4 py-2">
              <div className="text-sm font-medium text-foreground">{s.label}</div>
              <div className="text-xs text-muted-foreground">{s.meaning}</div>
            </div>
          ))}
          <p className="px-4 py-2 text-xs text-muted-foreground">
            Several statuses can share a stage. Complete and Invoiced are both Done, Paid and Cancelled are both
            Closed. The Order number sets the order statuses are listed in on the jobs pages.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
/**
 * The category values actually in the price book. Kept in step with
 * CATEGORY_LABEL in pages/products.tsx — this list had drifted and offered
 * "lvt" and "sundry", which nothing uses, while missing "accessory" and
 * "sheet_goods", which 700+ rows do. Editing a product off a wrong list is how
 * a line quietly disappears out of every filter that matters.
 */
const CATEGORIES = [
  "carpet",
  "carpet_tile",
  "vinyl",
  "hybrid",
  "laminate",
  "timber",
  "underlay",
  "turf",
  "sheet_goods",
  "accessory",
];
const UNITS = ["m2", "lm", "each", "roll", "box", "hour"];

type Tab = "skills" | "statuses" | "products" | "labour" | "business" | "email" | "backups";

const TABS: Array<{ id: Tab; label: string; blurb: string }> = [
  { id: "skills", label: "Skills", blurb: "What a task can be. Installers get ticked against these." },
  { id: "statuses", label: "Job statuses", blurb: "Your own words for where a job is up to." },
  { id: "products", label: "Price list", blurb: "Products you pull onto quotes. Cost stays admin-only." },
  {
    id: "labour",
    label: "Labour rates",
    blurb: "What Terra pays per work item. Installers follow these unless they have their own number.",
  },
  {
    id: "business",
    label: "Business rules",
    blurb: "Bank balance the forecast starts from, quote discounts, supervisors, offer rules, site circle, your details.",
  },
  {
    id: "email",
    label: "Email agent",
    blurb: "The mailboxes the agent reads supplier invoices from, and whether it may chase missing ones by itself.",
  },
  {
    id: "backups",
    label: "Your data",
    blurb: "Pull everything out as CSV or one JSON file, any time. Your data is yours.",
  },
];

/** Deep links land on the right tab: /settings?tab=business from the cashflow page. */
function initialTab(): Tab {
  const params = new URLSearchParams(window.location.search);
  // Google's sign-in sends Damien back to /settings?mail=…#email-agent.
  if (window.location.hash === "#email-agent" || params.has("mail")) return "email";
  const wanted = params.get("tab");
  return TABS.some((t) => t.id === wanted) ? (wanted as Tab) : "skills";
}

export default function SettingsPage() {
  const [tab, setTab] = React.useState<Tab>(initialTab);
  const boot = useBootstrap();

  return (
    <Page
      title="Settings"
      subtitle="Everything here is data, not code. Rename it, add to it, switch it off. No rebuild needed."
      wide
    >
      <div className="mb-5 flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              tab === t.id
                ? "rounded-md bg-[var(--sidebar)] px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{TABS.find((t) => t.id === tab)?.blurb}</p>

      {boot.isLoading ? <Loading /> : null}
      {boot.data && tab === "skills" ? <SkillsTab skills={boot.data.allSkills} /> : null}
      {boot.data && tab === "statuses" ? <StatusesTab statuses={boot.data.allStatuses} /> : null}
      {tab === "products" ? <ProductsTab /> : null}
      {tab === "labour" ? <LabourRatesTab /> : null}
      {boot.data && tab === "business" ? <BusinessTab settings={boot.data.settings} /> : null}
      {tab === "email" ? <EmailAgentCard /> : null}
      {tab === "backups" ? <BackupsTab /> : null}
    </Page>
  );
}

/* ------------------------------------------------------------------ skills */

type SkillRow = {
  id: number;
  name: string;
  groupName: string;
  defaultCrewSize: number;
  /** How the work gets crewed, and how much of it goes down in a day. */
  minCrew: number;
  recommendedCrew: number;
  productionRate: number | null;
  productionUnit: string;
  extraCrewUpliftPct: number;
  fixedDays: number;
  sortOrder: number;
  active: boolean;
};

function SkillsTab({ skills }: { skills: SkillRow[] }) {
  const [newOpen, setNewOpen] = React.useState(false);
  const [showInactive, setShowInactive] = React.useState(false);
  const rows = showInactive ? skills : skills.filter((s) => s.active);
  const groups = SKILL_GROUPS.filter((g) => rows.some((r) => r.groupName === g)).concat(
    Array.from(new Set(rows.map((r) => r.groupName).filter((g) => !SKILL_GROUPS.includes(g)))),
  );

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <label htmlFor={`settings_cb1`} className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox id={`settings_cb1`} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show switched off
        </label>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="size-4" />
          New skill
        </Button>
      </div>

      <div className="space-y-4">
        {groups.map((group) => (
          <Card key={group}>
            <CardHeader
              title={<span className="capitalize">{group}</span>}
              subtitle={`${rows.filter((r) => r.groupName === group).length} skills`}
            />
            <div className="divide-y divide-border">
              {rows
                .filter((r) => r.groupName === group)
                .map((skill) => (
                  <SkillLine key={skill.id} skill={skill} />
                ))}
            </div>
          </Card>
        ))}
        {rows.length === 0 ? (
          <Card>
            <Empty>No skills yet. Add the first one.</Empty>
          </Card>
        ) : null}
      </div>

      <NewSkillModal open={newOpen} onClose={() => setNewOpen(false)} nextSort={skills.length} />
    </>
  );
}

function SkillLine({ skill }: { skill: SkillRow }) {
  const update = useUpdateSkill();
  const [name, setName] = React.useState(skill.name);

  React.useEffect(() => setName(skill.name), [skill.name]);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name !== skill.name) update.mutate({ id: skill.id, name: name.trim() });
        }}
        className="h-8 max-w-xs flex-1"
      />
      <div className="flex items-center gap-1.5">
        <Label className="mb-0">Group</Label>
        <Select
          value={skill.groupName}
          onChange={(e) => update.mutate({ id: skill.id, groupName: e.target.value })}
          className="h-8 w-36"
        >
          {SKILL_GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </Select>
      </div>
      <label htmlFor={`skill_active_${skill.id}`} className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          id={`skill_active_${skill.id}`}
          checked={skill.active}
          onChange={(e) => update.mutate({ id: skill.id, active: e.target.checked })}
        />
        In use
      </label>
      {update.isPending ? <Spinner /> : null}

      {/* How it gets crewed and how fast it goes. This is what turns a quantity
          into days on site, so it is real numbers, not a crew 1 / crew 2 guess. */}
      <div className="flex w-full flex-wrap items-center gap-3 pl-1">
        <div className="flex items-center gap-1.5">
          <Label className="mb-0">Min crew</Label>
          <Select
            value={String(skill.minCrew ?? 1)}
            onChange={(e) => update.mutate({ id: skill.id, minCrew: Number(e.target.value) })}
            className="h-8 w-16"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="mb-0">Recommended</Label>
          <Select
            value={String(skill.recommendedCrew ?? 1)}
            onChange={(e) => update.mutate({ id: skill.id, recommendedCrew: Number(e.target.value) })}
            className="h-8 w-16"
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="mb-0">Gets through</Label>
          <ProductionRate skill={skill} />
          <Select
            value={skill.productionUnit ?? "m2"}
            onChange={(e) => update.mutate({ id: skill.id, productionUnit: e.target.value })}
            className="h-8 w-20"
          >
            {RATE_UNITS.filter((u) => u !== "percent" && u !== "km" && u !== "day" && u !== "hour").map((u) => (
              <option key={u} value={u}>
                {UNIT_LABEL[u]}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">for one person, per day</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="mb-0">Second person adds</Label>
          <Select
            value={String(skill.extraCrewUpliftPct ?? 35)}
            onChange={(e) => update.mutate({ id: skill.id, extraCrewUpliftPct: Number(e.target.value) })}
            className="h-8 w-20"
          >
            {[0, 10, 20, 25, 30, 35, 40, 50, 60, 70, 80, 90, 100].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">
            {skill.productionRate
              ? `so two get through about ${Math.round(skill.productionRate * (1 + (skill.extraCrewUpliftPct ?? 35) / 100) * 10) / 10} ${UNIT_LABEL[skill.productionUnit as keyof typeof UNIT_LABEL] ?? skill.productionUnit} a day, not double`
              : "two people are never twice as fast, they share the room"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Label className="mb-0">Waiting on top</Label>
          <Select
            value={String(skill.fixedDays ?? 0)}
            onChange={(e) => update.mutate({ id: skill.id, fixedDays: Number(e.target.value) })}
            className="h-8 w-24"
          >
            {[0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "none" : `${n} ${n === 1 ? "day" : "days"}`}
              </option>
            ))}
          </Select>
          <span className="text-xs text-muted-foreground">
            {skill.fixedDays
              ? "drying or curing, same whatever the size, and a second person can't speed it up"
              : "for drying or curing time that doesn't depend on the size"}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Blank on purpose until Damien knows the number. A made up production rate
    would quietly put a wrong completion date on a job. */
function ProductionRate({ skill }: { skill: SkillRow }) {
  const update = useUpdateSkill();
  const [text, setText] = React.useState(skill.productionRate == null ? "" : String(skill.productionRate));

  React.useEffect(() => {
    setText(skill.productionRate == null ? "" : String(skill.productionRate));
  }, [skill.productionRate]);

  function commit() {
    const trimmed = text.trim();
    if (trimmed === "") {
      if (skill.productionRate != null) update.mutate({ id: skill.id, productionRate: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n === skill.productionRate) {
      setText(skill.productionRate == null ? "" : String(skill.productionRate));
      return;
    }
    update.mutate({ id: skill.id, productionRate: n });
  }

  return (
    <Input
      value={text}
      inputMode="decimal"
      placeholder="not set"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="h-8 w-20 text-right"
    />
  );
}

function NewSkillModal({
  open,
  onClose,
  nextSort,
}: {
  open: boolean;
  onClose: () => void;
  nextSort: number;
}) {
  const create = useCreateSkill();
  const [name, setName] = React.useState("");
  const [groupName, setGroupName] = React.useState("carpet");
  const [crew, setCrew] = React.useState("1");
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        name: name.trim(),
        groupName,
        defaultCrewSize: Number(crew),
        recommendedCrew: Number(crew),
        sortOrder: nextSort,
      });
      setName("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New skill"
      subtitle="Tasks are dispatched by skill. Only installers ticked for it will ever see the work."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add skill
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Skill name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Stair nosings" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Group" hint="Sets the colour on the board">
            <Select value={groupName} onChange={(e) => setGroupName(e.target.value)}>
              {SKILL_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default crew size">
            <Select value={crew} onChange={(e) => setCrew(e.target.value)}>
              <option value="1">1, one man</option>
              <option value="2">2, needs two</option>
            </Select>
          </Field>
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------- statuses */

type StatusRow = {
  id: number;
  name: string;
  colour: string;
  stage: string;
  sortOrder: number;
  active: boolean;
};

function StatusesTab({ statuses }: { statuses: StatusRow[] }) {
  const [newOpen, setNewOpen] = React.useState(false);
  const [showInactive, setShowInactive] = React.useState(false);
  const rows = showInactive ? statuses : statuses.filter((s) => s.active);

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <label htmlFor={`settings_cb3`} className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox id={`settings_cb3`} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show switched off
        </label>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="size-4" />
          New status
        </Button>
      </div>

      <StageGuide />

      <Card>
        <CardHeader
          title="Job statuses"
          subtitle="Order sets where it sits in the list. Stage is what the system counts it as."
        />
        <div className="divide-y divide-border">
          {rows.map((s) => (
            <StatusLine key={s.id} status={s} />
          ))}
          {rows.length === 0 ? <Empty>No statuses yet.</Empty> : null}
        </div>
      </Card>

      <NewStatusModal open={newOpen} onClose={() => setNewOpen(false)} nextSort={statuses.length} />
    </>
  );
}

function StatusLine({ status }: { status: StatusRow }) {
  const update = useUpdateStatus();
  const [name, setName] = React.useState(status.name);
  const [sort, setSort] = React.useState(String(status.sortOrder));

  React.useEffect(() => setName(status.name), [status.name]);
  React.useEffect(() => setSort(String(status.sortOrder)), [status.sortOrder]);

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <input
        type="color"
                aria-label="Colour"
        value={status.colour}
        onChange={(e) => update.mutate({ id: status.id, colour: e.target.value })}
        className="size-8 cursor-pointer rounded border border-border bg-card p-0.5"
        title="Colour on the board"
      />
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          if (name.trim() && name !== status.name) update.mutate({ id: status.id, name: name.trim() });
        }}
        className="h-8 max-w-xs flex-1"
      />
      <Badge colour={status.colour}>{status.name}</Badge>
      <div className="flex items-center gap-1.5">
        <Label className="mb-0">Stage</Label>
        <Select
          value={status.stage}
          onChange={(e) => update.mutate({ id: status.id, stage: e.target.value })}
          className="h-8 w-36"
        >
          <StageOptions current={status.stage} />
        </Select>
      </div>
      <div className="flex items-center gap-1.5">
        <Label className="mb-0">Order</Label>
        <Input
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          onBlur={() => {
            const n = Number(sort);
            if (!Number.isNaN(n) && n !== status.sortOrder) update.mutate({ id: status.id, sortOrder: n });
          }}
          className="h-8 w-16"
        />
      </div>
      <label htmlFor={`status_active_${status.id}`} className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox id={`status_active_${status.id}`}
          checked={status.active}
          onChange={(e) => update.mutate({ id: status.id, active: e.target.checked })}
        />
        In use
      </label>
      {update.isPending ? <Spinner /> : null}
    </div>
  );
}

function NewStatusModal({ open, onClose, nextSort }: { open: boolean; onClose: () => void; nextSort: number }) {
  const create = useCreateStatus();
  const [name, setName] = React.useState("");
  const [colour, setColour] = React.useState("#4A7FA5");
  const [stage, setStage] = React.useState("open");
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), colour, stage, sortOrder: nextSort });
      setName("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New job status"
      subtitle="Use your own language: 'Waiting on stock', 'Measure booked', whatever you say on the phone."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add status
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Status name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Waiting on stock" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Colour">
            <input
              type="color"
                aria-label="Colour"
              value={colour}
              onChange={(e) => setColour(e.target.value)}
              className="h-9 w-full cursor-pointer rounded-md border border-border bg-card p-1"
            />
          </Field>
          <Field label="Stage" hint="What it counts as">
            <Select value={stage} onChange={(e) => setStage(e.target.value)}>
              <StageOptions />
            </Select>
          </Field>
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------- products */

function ProductsTab() {
  const products = useProducts();
  const [q, setQ] = React.useState("");
  const [newOpen, setNewOpen] = React.useState(false);
  const [showInactive, setShowInactive] = React.useState(false);

  const rows = (products.data ?? []).filter((p) => {
    if (!showInactive && !p.active) return false;
    if (!q.trim()) return true;
    const hay = [p.supplier, p.brand, p.range, p.colour, p.sku].join(" ").toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search supplier, brand, range, colour"
            className="pl-9"
          />
        </div>
        <label htmlFor={`settings_cb5`} className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox id={`settings_cb5`} checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show discontinued
        </label>
        <Button className="ml-auto" onClick={() => setNewOpen(true)}>
          <Plus className="size-4" />
          New product
        </Button>
      </div>

      <Card>
        <CardHeader
          title="Price list"
          subtitle="Cost price never leaves this screen and the quote margin card. Installers can't see any of it."
          action={<span className="label-xs">{rows.length} products</span>}
        />
        {products.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>Nothing on the price list yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="th px-4">Supplier</th>
                  <th className="th px-4">Brand / range</th>
                  <th className="th px-4">Colour</th>
                  <th className="th px-4">Category</th>
                  <th className="th px-4">Unit</th>
                  <th className="th px-4 text-right">Cost</th>
                  <th className="th px-4 text-right">Sell</th>
                  <th className="th px-4 text-right">Margin</th>
                  <th className="th px-4" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <ProductLine key={p.id} product={p} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewProductModal open={newOpen} onClose={() => setNewOpen(false)} />
    </>
  );
}

type ProductRow = {
  id: number;
  supplier: string;
  brand: string;
  range: string;
  colour: string;
  category: string;
  unit: string;
  costPrice: number | null;
  sellPrice: number | null;
  sku: string | null;
  active: boolean;
};

function ProductLine({ product }: { product: ProductRow }) {
  const update = useUpdateProduct();
  const [cost, setCost] = React.useState(product.costPrice === null ? "" : String(product.costPrice));
  const [sell, setSell] = React.useState(product.sellPrice === null ? "" : String(product.sellPrice));

  React.useEffect(() => setCost(product.costPrice === null ? "" : String(product.costPrice)), [product.costPrice]);
  React.useEffect(() => setSell(product.sellPrice === null ? "" : String(product.sellPrice)), [product.sellPrice]);

  const margin =
    product.sellPrice && product.costPrice ? ((product.sellPrice - product.costPrice) / product.sellPrice) * 100 : null;

  return (
    <tr className={product.active ? "" : "opacity-50"}>
      <td className="px-4 py-2">{product.supplier || "-"}</td>
      <td className="px-4 py-2">
        <span className="font-medium">{product.brand}</span>
        {product.range ? <span className="text-muted-foreground"> · {product.range}</span> : null}
        {product.sku ? <div className="text-xs text-muted-foreground">{product.sku}</div> : null}
      </td>
      <td className="px-4 py-2">{product.colour || "-"}</td>
      <td className="px-4 py-2">
        <Select
          value={product.category}
          onChange={(e) => update.mutate({ id: product.id, category: e.target.value })}
          className="h-8 w-32"
        >
          {CATEGORIES.concat(CATEGORIES.includes(product.category) ? [] : [product.category]).map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-4 py-2">
        <Select
          value={product.unit}
          onChange={(e) => update.mutate({ id: product.id, unit: e.target.value })}
          className="h-8 w-20"
        >
          {UNITS.concat(UNITS.includes(product.unit) ? [] : [product.unit]).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-4 py-2 text-right">
        <Input
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          onBlur={() => {
            const v = cost.trim() === "" ? null : Number(cost);
            if (v !== product.costPrice && (v === null || !Number.isNaN(v)))
              update.mutate({ id: product.id, costPrice: v });
          }}
          className="tabular h-8 w-24 text-right"
        />
      </td>
      <td className="px-4 py-2 text-right">
        <Input
          value={sell}
          onChange={(e) => setSell(e.target.value)}
          onBlur={() => {
            const v = sell.trim() === "" ? null : Number(sell);
            if (v !== product.sellPrice && (v === null || !Number.isNaN(v)))
              update.mutate({ id: product.id, sellPrice: v });
          }}
          className="tabular h-8 w-24 text-right"
        />
      </td>
      <td className="tabular px-4 py-2 text-right">
        {margin === null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span className={margin < 20 ? "text-destructive" : "text-[var(--success)]"}>{margin.toFixed(0)}%</span>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        <label htmlFor={`settings_cb6`} className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <Checkbox id={`settings_cb6`}
            checked={product.active}
            onChange={(e) => update.mutate({ id: product.id, active: e.target.checked })}
          />
          Stocked
        </label>
      </td>
    </tr>
  );
}

function NewProductModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateProduct();
  const suppliers = useSuppliers();
  const createSupplier = useCreateSupplier();
  // "" = none picked, "new" = adding one here, otherwise a supplier id.
  const [supplierPick, setSupplierPick] = React.useState("");
  const [newSupplierName, setNewSupplierName] = React.useState("");
  const [form, setForm] = React.useState({
    brand: "",
    range: "",
    colour: "",
    category: "carpet",
    unit: "m2",
    costPrice: "",
    sellPrice: "",
    sku: "",
  });
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    try {
      let supplierId: number | null = supplierPick && supplierPick !== "new" ? Number(supplierPick) : null;
      if (supplierPick === "new") {
        const name = newSupplierName.trim();
        if (!name) throw new Error("Type the new supplier's name, or pick one from the list.");
        const made = await createSupplier.mutateAsync({ name, code: name });
        supplierId = made.id;
        setSupplierPick(String(made.id));
        setNewSupplierName("");
      }
      await create.mutateAsync({
        supplierId,
        brand: form.brand,
        range: form.range,
        colour: form.colour,
        category: form.category,
        unit: form.unit,
        costPrice: form.costPrice.trim() === "" ? null : Number(form.costPrice),
        sellPrice: form.sellPrice.trim() === "" ? null : Number(form.sellPrice),
        sku: form.sku || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New product"
      subtitle="Anything you quote off a supplier price list."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.brand.trim() || create.isPending || createSupplier.isPending}>
            {create.isPending || createSupplier.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add product
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Supplier"
          hint={supplierPick === "new" ? "Saved to your supplier list. Add their email and account number on the Suppliers page." : undefined}
        >
          <Select value={supplierPick} onChange={(e) => setSupplierPick(e.target.value)}>
            <option value="">Choose a supplier</option>
            {(suppliers.data ?? []).map((sup) => (
              <option key={sup.id} value={sup.id}>
                {sup.name}
              </option>
            ))}
            <option value="new">+ Add a new supplier</option>
          </Select>
          {supplierPick === "new" ? (
            <Input
              className="mt-2"
              value={newSupplierName}
              onChange={(e) => setNewSupplierName(e.target.value)}
              placeholder="New supplier name"
            />
          ) : null}
        </Field>
        <Field label="Brand">
          <Input value={form.brand} onChange={(e) => set("brand", e.target.value)} />
        </Field>
        <Field label="Range">
          <Input value={form.range} onChange={(e) => set("range", e.target.value)} />
        </Field>
        <Field label="Colour">
          <Input value={form.colour} onChange={(e) => set("colour", e.target.value)} />
        </Field>
        <Field label="Category">
          <Select value={form.category} onChange={(e) => set("category", e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unit">
          <Select value={form.unit} onChange={(e) => set("unit", e.target.value)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Cost price" hint="Never shown to installers or customers">
          <Input value={form.costPrice} onChange={(e) => set("costPrice", e.target.value)} />
        </Field>
        <Field label="Sell price">
          <Input value={form.sellPrice} onChange={(e) => set("sellPrice", e.target.value)} />
        </Field>
        <Field label="Supplier code / SKU" className="sm:col-span-2">
          <Input value={form.sku} onChange={(e) => set("sku", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ---------------------------------------------------------------- business */

function BusinessTab({ settings }: { settings: Record<string, string> }) {
  const save = useSetSetting();
  const [draft, setDraft] = React.useState<Record<string, string>>(settings);
  const [saved, setSaved] = React.useState<string | null>(null);

  React.useEffect(() => setDraft(settings), [settings]);

  function commit(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    save.mutate(
      { key, value },
      {
        onSuccess: () => {
          setSaved(key);
          window.setTimeout(() => setSaved((s) => (s === key ? null : s)), 1500);
        },
      },
    );
  }

  const tick = (key: string) => (saved === key ? <span className="text-xs text-[var(--success)]">Saved</span> : null);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <CashPositionCard />
      <Card>
        <CardHeader title="Office quote discounts" subtitle="How far Office can discount a quote before an Admin has to approve it." />
        <div className="space-y-4 px-4 py-4">
          <Field label="Discount limit (%)" hint="Applies to everyone with Office access. Anything above it waits for an Admin before the quote can be sent.">
            <div className="flex items-center gap-2">
              <Input
                value={draft.office_discount_limit_percent ?? "5"}
                onChange={(e) => setDraft((d) => ({ ...d, office_discount_limit_percent: e.target.value }))}
                onBlur={(e) => commit("office_discount_limit_percent", e.target.value)}
                className="tabular w-24"
              />
              {tick("office_discount_limit_percent")}
            </div>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Supervisors" subtitle="When a supervisor counts as gone quiet." />
        <div className="space-y-4 px-4 py-4">
          <Field label="Gone quiet after (months)" hint="If a supervisor who has sent work before sends no job or quote request for this long, they show on the Supervisors page and the Dashboard.">
            <div className="flex items-center gap-2">
              <Input
                value={draft.supervisor_quiet_months ?? "3"}
                onChange={(e) => setDraft((d) => ({ ...d, supervisor_quiet_months: e.target.value }))}
                onBlur={(e) => commit("supervisor_quiet_months", e.target.value)}
                className="tabular w-24"
              />
              {tick("supervisor_quiet_months")}
            </div>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Offers and what crew see" subtitle="Fixed rules, not settings." />
        <div className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
          <p>An unanswered offer lapses after 2 hours and comes back to you on the dashboard.</p>
          <p>The installer always sees their pay in the offer.</p>
          <p>
            Crew see only the people you tick Show to Crew on each job. A job with nobody ticked shows Crew nobody.
          </p>
          <div className="rounded-md bg-secondary px-3 py-2 text-xs">
            Locked permanently: installers never see quotes, invoices, job value, supplier costs, margins, or another
            installer's tasks and rates.
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Arriving at site"
          subtitle="The crew app marks Arrived and Left site by itself when a phone crosses the circle round the address."
        />
        <div className="space-y-3 px-4 py-4">
          <Field label="Site circle" hint="Metres from the address. 100 to 1000. Bigger suits acreage and big builds.">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={100}
                max={1000}
                step={25}
                value={draft.site_circle_m ?? "150"}
                onChange={(e) => setDraft((d) => ({ ...d, site_circle_m: e.target.value }))}
                onBlur={(e) => {
                  const n = Math.round(Number(e.target.value));
                  const v = String(Number.isFinite(n) && n > 0 ? Math.min(1000, Math.max(100, n)) : 150);
                  setDraft((d) => ({ ...d, site_circle_m: v }));
                  commit("site_circle_m", v);
                }}
                className="tabular w-28"
              />
              <span className="text-sm text-muted-foreground">m</span>
              {tick("site_circle_m")}
            </div>
          </Field>
          <div className="rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Inside the circle under 5 minutes is a drive past and is not counted. Arriving only stamps Arrived, it
            never starts the dispatch. Leaving without that day's completion photos turns the visit red on the dashboard
            until the photos go in or they come back the same day.
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Your details" subtitle="The office number the crew app rings. GST is fixed at 10%." />
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
          <Field label="Business phone">
            <div className="flex items-center gap-2">
              <Input
                value={draft.business_phone ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, business_phone: e.target.value }))}
                onBlur={(e) => commit("business_phone", e.target.value)}
              />
              {tick("business_phone")}
            </div>
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Anything else" subtitle="Every other saved setting, straight from the database." />
        <div className="divide-y divide-border">
          {Object.keys(draft)
            .filter(
              (k) =>
                ![
                  "offer_expiry_hours",
                  "broadcast_shows_pay",
                  "installer_can_see_customer_name",
                  "installer_can_see_customer_phone",
                  "business_name",
                  "business_phone",
                  "gst_rate",
                  "site_circle_m",
                  // The job number counter. Never hand-edited here.
                  "job_number_last",
                ].includes(k),
            )
            .map((k) => (
              <div key={k} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm">{k.replace(/_/g, " ")}</span>
                <Input
                  value={draft[k] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                  onBlur={(e) => commit(k, e.target.value)}
                  className="h-8 max-w-[12rem]"
                />
                {tick(k)}
              </div>
            ))}
          {Object.keys(draft).length <= 7 ? <Empty>Nothing extra. The ones above are all of them.</Empty> : null}
        </div>
      </Card>
    </div>
  );
}


/* ---------------------------------------------------------------- backups */

/**
 * PHASE 0 — Damien asked "what happens if Runable goes bankrupt". This tab is
 * the answer he can click himself: every table out as CSV, or the whole lot as
 * one JSON snapshot. A nightly copy of the same thing runs on the server
 * (scripts/backup.ts) and the runbook explains how to restore it anywhere.
 */
function BackupsTab() {
  const datasets = useDatasets();
  const csv = useExportCsv();
  const snapshot = useExportSnapshot();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  async function pullCsv(dataset: string, label: string) {
    setBusy(dataset);
    setNote(null);
    try {
      const res = await csv.mutateAsync({ dataset: dataset as never });
      if (!res.rows) {
        setNote(`${label}: nothing in there yet.`);
        return;
      }
      downloadText(res.filename, res.csv);
      setNote(`${label}: ${res.rows} rows downloaded.`);
    } finally {
      setBusy(null);
    }
  }

  async function pullEverything() {
    setBusy("__all");
    setNote(null);
    try {
      const res = await snapshot.mutateAsync({});
      downloadText(res.filename, res.json, "application/json");
      setNote(`Full snapshot downloaded, ${res.rows} rows across every table.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Take the whole lot"
          subtitle="One JSON file with every table in it. This is the file that rebuilds Terra Flooring from nothing."
        />
        <div className="flex flex-wrap items-center gap-3 px-4 py-4">
          <Button onClick={pullEverything} disabled={busy === "__all"}>
            {busy === "__all" ? <Spinner className="mr-2" /> : <HardDriveDownload className="mr-2 size-4" />}
            Download full snapshot
          </Button>
          <p className="text-xs text-muted-foreground">
            A copy of this is also written on the server every night. See RUNBOOK.md for how to restore it.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Take one thing at a time"
          subtitle="Plain CSV. Opens straight in Excel or Google Sheets."
        />
        {datasets.isLoading ? <Loading /> : null}
        <div className="divide-y divide-border">
          {(datasets.data ?? []).map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{d.label}</p>
                <p className="text-xs text-muted-foreground">{d.blurb}</p>
              </div>
              <Badge>{d.rows} rows</Badge>
              <Button
                variant="outline"
                size="sm"
                disabled={busy === d.id}
                onClick={() => pullCsv(d.id, d.label)}
              >
                {busy === d.id ? <Spinner className="mr-2" /> : <Download className="mr-2 size-4" />}
                CSV
              </Button>
            </div>
          ))}
        </div>
        {note ? <p className="px-4 py-3 text-xs text-muted-foreground">{note}</p> : null}
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------- cash position */

/**
 * The opening balance every cashflow number is walked forward from. Manual for
 * now, by design: Damien has no Xero feed yet, and a forecast starting from
 * zero is a forecast that lies about the low point. When Xero is connected it
 * takes over the tile on the Cashflow page and this stays as the fallback.
 */
function CashPositionCard() {
  const current = useOpeningBalance();
  const save = useSetOpeningBalance();
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState("");
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    if (!current.data) return;
    setAmount(current.data.source === "manual" ? String(current.data.amount) : "");
    setDate(current.data.date);
  }, [current.data]);

  const parsed = Number(amount.replace(/[$,\s]/g, ""));
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}$/.test(date);

  function commit() {
    if (!valid) return;
    save.mutate(
      { amount: parsed, date },
      {
        onSuccess: () => {
          setSaved(true);
          window.setTimeout(() => setSaved(false), 2000);
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader
        title="Cash position"
        subtitle="What is in the bank right now. Every cashflow and forecast number starts from this."
        action={
          current.data?.source === "manual" ? (
            <Badge colour="#3F7D3A">Set</Badge>
          ) : (
            <Badge colour="#D08A1E">Not set</Badge>
          )
        }
      />
      <div className="space-y-4 px-4 py-4">
        {current.isLoading ? (
          <Loading />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bank balance" hint="Cleared funds, not the pending figure.">
                <Input
                  value={amount}
                  inputMode="decimal"
                  placeholder="0.00"
                  onChange={(e) => setAmount(e.target.value)}
                  className="tabular"
                />
              </Field>
              <Field label="As at" hint="The date that balance was true.">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="tabular" />
              </Field>
            </div>

            <div className="flex items-center gap-3">
              <Button onClick={commit} disabled={!valid || save.isPending}>
                {save.isPending ? <Spinner /> : null}
                Save balance
              </Button>
              {saved ? <span className="text-xs text-[var(--success)]">Saved, forecast rebuilt</span> : null}
              {save.isError ? (
                <span className="text-xs text-destructive">That did not save. Check the figure and try again.</span>
              ) : null}
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              {current.data?.source === "manual"
                ? `Currently forecasting from ${moneyExact(current.data.amount)} as at ${longDate(current.data.date)}. Update it whenever you check the account, it takes a second and it keeps the low point honest.`
                : "Nothing set, so the forecast is running from zero and the low points on the Cashflow page are only the shape of the movement, not the real balance."}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
