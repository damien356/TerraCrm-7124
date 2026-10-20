import { Redirect, Route, Switch } from "wouter";
import { Provider } from "./components/provider";
import { Layout } from "./components/layout";
import { AgentFeedback } from "@runablehq/website-runtime";
import { authClient } from "./lib/auth";
import Index from "./pages/index";
import LoginPage from "./pages/login";
import SchedulePage from "./pages/schedule";
import JobsPage from "./pages/jobs";
import JobDetailPage from "./pages/job-detail";
import CrewPage from "./pages/crew";
import QuotesPage from "./pages/quotes";
import QuoteBuilderPage from "./pages/quote-builder";
import VoiceQuotesPage from "./pages/voice-quotes";
import ClientsPage from "./pages/clients";
import ContactDetailPage from "./pages/contact-detail";
import CompaniesPage from "./pages/companies";
import CompanyDetailPage from "./pages/company-detail";
import TeamPage from "./pages/team";
import SuppliersPage from "./pages/suppliers";
import ProductsPage from "./pages/products";
import SettingsPage from "./pages/settings";
import SafetyPage from "./pages/safety";
import SwmsLibraryPage from "./pages/swms-library";
import ReviewPage from "./pages/review";
import ConversationsPage from "./pages/conversations";
import SupervisorsPage from "./pages/supervisors";
import SupervisorDetailPage from "./pages/supervisor-detail";
import CashflowPage from "./pages/finance-cashflow";
import ForecastingPage from "./pages/finance-forecasting";
import InvoicesPage from "./pages/finance-invoices";
import SubcontractorInvoicesPage from "./pages/subcontractor-invoices";
import ExpensesPage from "./pages/finance-expenses";
import SuppliersOwedPage from "./pages/suppliers-owed";
import ReferrersOwedPage from "./pages/referrers-owed";
import ProfitabilityPage from "./pages/finance-profitability";
import CallbacksReportPage from "./pages/callbacks-report";
import TemplatesPage from "./pages/templates";
import CarePage from "./pages/care";
import SegmentsPage from "./pages/segments";
import TerraAiPage from "./pages/terra-ai";
import ReferrersPage from "./pages/referrers";
import DuplicatesPage from "./pages/duplicates";
import CompanyTypesPage from "./pages/company-types";
import DepositsToFillPage from "./pages/deposits-to-fill";
import PrepToFillPage from "./pages/prep-to-fill";
import PublicQuotePage from "./pages/public-quote";
import PublicSelectionPage from "./pages/public-selection";
import PublicPayPage from "./pages/public-pay";
import PublicTradePayPage from "./pages/public-trade-pay";
import TradePage from "./pages/trade";
import TradeSalePage from "./pages/trade-sale";
import PublicVariationPage from "./pages/public-variation";
import PublicRepairPage from "./pages/public-repair";
import PublicAppPage from "./pages/public-app";
import PublicPrivacyPage from "./pages/public-privacy";
import PublicSetupPage from "./pages/public-setup";
import RepairsPage from "./pages/repairs";
import RepairDetailPage from "./pages/repair-detail";
import LeadsReportPage from "./pages/leads-report";

// Finish a returning managed sign-in before anything renders. This top-level
// await resolves before __main.tsx mounts React (app.tsx is its dependency).
await authClient.managedAuth.handleRedirect();

function NotFound() {
  return (
    <div className="px-6 py-16 text-center">
      <p className="text-sm text-muted-foreground">That page doesn't exist.</p>
    </div>
  );
}

function App() {
  return (
    <Provider>
      {/* Client pages opened from an email link. Outside Layout, which sends anyone signed out to /login. */}
      <Switch>
        <Route path="/q/:token" component={PublicQuotePage} />
        <Route path="/m/:token" component={PublicSelectionPage} />
        <Route path="/pay/:token" component={PublicPayPage} />
        <Route path="/tp/:token" component={PublicTradePayPage} />
        <Route path="/v/:token" component={PublicVariationPage} />
        <Route path="/r/:token" component={PublicRepairPage} />
        {/* Staff invites (notes 18.55): the app download and the one-time password set-up. */}
        <Route path="/app" component={PublicAppPage} />
        <Route path="/privacy-policy" component={PublicPrivacyPage} />
        <Route path="/privacy" component={PublicPrivacyPage} />
        <Route path="/setup/:token" component={PublicSetupPage} />
        <Route>
          <Layout>
            <Switch>
              <Route path="/login" component={LoginPage} />
              <Route path="/" component={Index} />
              <Route path="/conversations" component={ConversationsPage} />
              <Route path="/schedule" component={SchedulePage} />
              <Route path="/jobs" component={JobsPage} />
              <Route path="/jobs/:id" component={JobDetailPage} />
              <Route path="/crew" component={CrewPage} />
              <Route path="/quotes" component={QuotesPage} />
              <Route path="/quotes/:id" component={QuoteBuilderPage} />
              <Route path="/voice-quotes" component={VoiceQuotesPage} />
              <Route path="/clients" component={ClientsPage} />
              <Route path="/clients/:id" component={ContactDetailPage} />
              <Route path="/companies" component={CompaniesPage} />
              <Route path="/companies/types" component={CompanyTypesPage} />
              <Route path="/deposits-to-fill" component={DepositsToFillPage} />
              <Route path="/prep-to-fill" component={PrepToFillPage} />
              <Route path="/companies/:id" component={CompanyDetailPage} />
              <Route path="/supervisors" component={SupervisorsPage} />
              <Route path="/supervisors/:id" component={SupervisorDetailPage} />
              <Route path="/referrers" component={ReferrersPage} />
              <Route path="/finance/cashflow" component={CashflowPage} />
              <Route path="/finance/forecasting" component={ForecastingPage} />
              <Route path="/finance/invoices" component={InvoicesPage} />
              <Route path="/finance/subcontractor-invoices" component={SubcontractorInvoicesPage} />
              <Route path="/finance/expenses" component={ExpensesPage} />
              <Route path="/finance/suppliers-owed" component={SuppliersOwedPage} />
              <Route path="/finance/referrers-owed" component={ReferrersOwedPage} />
              <Route path="/finance/profitability" component={ProfitabilityPage} />
              <Route path="/finance/callbacks" component={CallbacksReportPage} />
              <Route path="/finance/trade" component={TradePage} />
              <Route path="/finance/trade/:id" component={TradeSalePage} />
              <Route path="/reports/leads" component={LeadsReportPage} />
              <Route path="/repairs" component={RepairsPage} />
              <Route path="/repairs/:id" component={RepairDetailPage} />
              <Route path="/marketing/templates" component={TemplatesPage} />
              <Route path="/marketing/segments" component={SegmentsPage} />
              <Route path="/marketing/care" component={CarePage} />
              <Route path="/terra-ai" component={TerraAiPage} />
              <Route path="/review/duplicates" component={DuplicatesPage} />
              <Route path="/review" component={ReviewPage} />
              <Route path="/installers">{() => <Redirect to="/team" />}</Route>
              <Route path="/team" component={TeamPage} />
              <Route path="/suppliers" component={SuppliersPage} />
              <Route path="/products" component={ProductsPage} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/swms-library" component={SwmsLibraryPage} />
              <Route path="/safety" component={SafetyPage} />
              <Route component={NotFound} />
            </Switch>
          </Layout>
        </Route>
      </Switch>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
  );
}

export default App;
