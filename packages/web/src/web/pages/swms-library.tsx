import * as React from "react";
import { Page } from "../components/layout";
import { Card, Empty, Loading } from "../components/ui/card";
import { useSwmsLibrary } from "../queries/swms-lib";
import { TemplatesTab } from "../components/swms-lib/templates";
import { BlocksTab } from "../components/swms-lib/blocks";
import { ChangeLogTab, SiteChecksTab } from "../components/swms-lib/checks";
import { SdsProductsTab } from "../components/swms-lib/sds";

const TABS = [
  ["templates", "Templates"],
  ["blocks", "Task blocks"],
  ["checks", "Site checks"],
  ["sds", "SDS products"],
  ["log", "Change log"],
] as const;
type Tab = (typeof TABS)[number][0];

/**
 * The SWMS library: build templates from task blocks, publish versions the
 * crew signs, and keep the site checks and SDS product list. Office and Admin.
 */
export default function SwmsLibraryPage() {
  const [tab, setTab] = React.useState<Tab>("templates");
  const q = useSwmsLibrary();
  const data = q.data;

  return (
    <Page
      title="SWMS library"
      subtitle="Templates the crew signs on site. Edits stay as drafts until you publish, and every signed SWMS keeps the version it was signed on."
      wide
      actions={
        data?.ready ? (
          <div className="flex flex-wrap gap-1 rounded-md bg-secondary p-1">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`rounded px-3 py-1 text-xs font-medium ${tab === k ? "bg-background shadow-xs" : "text-muted-foreground"}`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : !data ? (
        <Card>
          <Empty>Couldn't load the SWMS library.</Empty>
        </Card>
      ) : !data.ready ? (
        <Card>
          <Empty>
            The SWMS library isn't set up on this system yet. Crew still sign the built-in SWMS until it is.
          </Empty>
        </Card>
      ) : tab === "templates" ? (
        <TemplatesTab data={data} />
      ) : tab === "blocks" ? (
        <BlocksTab data={data} />
      ) : tab === "checks" ? (
        <SiteChecksTab data={data} />
      ) : tab === "sds" ? (
        <SdsProductsTab data={data} />
      ) : (
        <ChangeLogTab />
      )}
    </Page>
  );
}
