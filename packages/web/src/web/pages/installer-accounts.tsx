import { useLocation, useSearch } from "wouter";
import { Page } from "../components/layout";
import { Card, Empty, Loading } from "../components/ui/card";
import { Field, Select } from "../components/ui/field";
import { InstallerAccountTab } from "../components/installer-account";
import { useInstallers } from "../queries/installers";

/**
 * INSTALLER ACCOUNTS.
 *
 * The office way in to an installer's Account tab, without the admin-only
 * People page. Office can set who he is billed as and raise a materials
 * invoice here. Contras stay Admin only: the server hides them from the
 * overview for Office and refuses every contra call from an Office login.
 */
export default function InstallerAccountsPage() {
  const installers = useInstallers(false);
  const [, setLocation] = useLocation();
  const picked = Number(new URLSearchParams(useSearch()).get("id")) || null;
  const list = installers.data ?? [];
  const known = picked != null && list.some((i) => i.id === picked);

  return (
    <Page
      title="Installer accounts"
      subtitle="Who an installer is billed as, and materials invoices to him. Office or Admin."
    >
      <div className="space-y-4">
        <Card className="px-4 py-3.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Installer">
              <Select
                data-testid="installer-account-picker"
                value={known ? String(picked) : ""}
                onChange={(e) => setLocation(e.target.value ? `/finance/installer-accounts?id=${e.target.value}` : "/finance/installer-accounts")}
              >
                <option value="">Pick an installer</option>
                {list.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
        {installers.isLoading ? (
          <Loading />
        ) : known ? (
          <InstallerAccountTab key={picked} id={picked!} />
        ) : (
          <Card>
            <Empty>Pick an installer to open his account.</Empty>
          </Card>
        )}
      </div>
    </Page>
  );
}
