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
import ProfitabilityPage from "./pages/finance-profitability";
import TemplatesPage from "./pages/templates";
import SegmentsPage from "./pages/segments";
import TerraAiPage from "./pages/terra-ai";
import ReferrersPage from "./pages/referrers";
import DuplicatesPage from "./pages/duplicates";
import CompanyTypesPage from "./pages/company-types";

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
          <Route path="/finance/profitability" component={ProfitabilityPage} />
          <Route path="/marketing/templates" component={TemplatesPage} />
          <Route path="/marketing/segments" component={SegmentsPage} />
          <Route path="/terra-ai" component={TerraAiPage} />
          <Route path="/review/duplicates" component={DuplicatesPage} />
          <Route path="/review" component={ReviewPage} />
          <Route path="/installers">{() => <Redirect to="/team" />}</Route>
          <Route path="/team" component={TeamPage} />
          <Route path="/suppliers" component={SuppliersPage} />
          <Route path="/products" component={ProductsPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/safety" component={SafetyPage} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
      {/* Do not remove — off by default, activated by parent iframe via postMessage */}
      {import.meta.env.DEV && <AgentFeedback />}
    </Provider>
  );
}

export default App;
