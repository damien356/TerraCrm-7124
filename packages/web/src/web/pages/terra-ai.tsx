import { Link } from "wouter";
import { Activity, Bot, ClipboardCheck, MessageCircleQuestion, Mic, PhoneCall, Sparkles } from "lucide-react";
import { Page } from "../components/layout";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { PhoneSetupNotes } from "../components/phone-calls";
import { usePhoneStatus } from "../queries/phoneCalls";

/**
 * The Terra AI shell. The section exists in the sidebar from today so the
 * place is settled, but nothing here runs yet. Each card is a capability we
 * have agreed to build, named so the office knows what is coming.
 */
const PLANNED = [
  {
    icon: Mic,
    title: "Quick capture",
    body: "Talk or type a note after a site visit and let Terra turn it into the quote, job or task it belongs to.",
  },
  {
    icon: Bot,
    title: "Agents",
    body: "Specialist agents working across quoting, scheduling, chasing money and supplier pricing.",
  },
  {
    icon: ClipboardCheck,
    title: "Needs review",
    body: "Anything an agent wants to do that matters enough to wait for a person waits here.",
  },
  {
    icon: Activity,
    title: "Activity",
    body: "A full trail of every AI action, what it changed and who approved it.",
  },
  {
    icon: MessageCircleQuestion,
    title: "Ask Terra",
    body: "Plain questions about the business, answered from actual Terra Ops records.",
  },
];

/** The one AI piece that exists: the phone agent. Its real state, not a promise. */
function PhoneAgentCard() {
  const s = usePhoneStatus();
  const on = !!s.data?.enabled && !s.data.tablesMissing.length && s.data.retellKeySet;
  return (
    <Card className="px-6 py-6">
      <div className="flex flex-wrap items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10">
          <PhoneCall className="size-5 text-primary" />
        </span>
        <div className="min-w-0 max-w-2xl flex-1">
          <h2 className="text-base font-semibold">AI phone agent {s.data ? (on ? "is on" : "is not live yet") : ""}</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Answers calls through Retell, looks up jobs, takes enquiries, books measures and callbacks, and leaves a follow-up for the right person
            when something still needs doing.
          </p>
          <div className="mt-3">
            <PhoneSetupNotes />
          </div>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/phone-calls">Open AI phone calls</Link>
        </Button>
      </div>
    </Card>
  );
}

export default function TerraAiPage() {
  return (
    <Page
      title="Terra AI"
      subtitle="One AI system for Terra Ops, with specialist agents underneath it."
    >
      <Card className="px-6 py-7">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary/10">
            <Sparkles className="size-5 text-primary" />
          </span>
          <div className="max-w-2xl">
            <h2 className="text-base font-semibold">The rest is still to come</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Apart from the phone agent below, nothing here is built yet. No other agent is reading your data or
              changing records.
            </p>
          </div>
        </div>
      </Card>

      <div className="mt-4">
        <PhoneAgentCard />
      </div>

      <p className="mt-7 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        What goes in here
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {PLANNED.map((item) => (
          <Card key={item.title} className="px-5 py-5">
            <item.icon className="size-[18px] text-primary" />
            <h3 className="mt-3 text-sm font-semibold">{item.title}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{item.body}</p>
          </Card>
        ))}
      </div>
    </Page>
  );
}
