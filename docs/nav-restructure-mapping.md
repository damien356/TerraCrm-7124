# Terra Ops navigation: the shipped structure

Locked and approved. Ten top-level areas, nothing gets added as an eleventh.
Anything new goes inside the area it belongs to.

Guiding principle: simple on the surface, powerful underneath.

## Sidebar, as built

| Sidebar | Route | Note |
| --- | --- | --- |
| Dashboard | `/` | |
| Conversations | `/conversations` | |
| Pipeline > Quotes | `/quotes` | Pipeline Board comes later |
| Jobs | `/jobs` | |
| Schedule > Board | `/schedule` | |
| Schedule > Crew map | `/crew` | |
| Customers > Clients | `/clients` | |
| Customers > Companies | `/companies` | |
| Customers > Supervisors | `/supervisors` | |
| Finance > Cashflow | `/finance/cashflow` | |
| Finance > Forecasting | `/finance/forecasting` | |
| Finance > Invoices | `/finance/invoices` | |
| Finance > Installer invoices | `/finance/subcontractor-invoices` | route name kept on purpose |
| Finance > Expenses | `/finance/expenses` | |
| Finance > Suppliers | `/suppliers` | not under `/finance`, kept as is |
| Finance > Profitability | `/finance/profitability` | |
| Marketing > Email templates | `/marketing/templates` | |
| Marketing > Segments | `/marketing/segments` | Overview, Journeys, Campaigns come later |
| Terra AI | `/terra-ai` | new placeholder page, no functionality |
| Admin > Settings | `/settings` | |
| Admin > Installers | `/installers` | master record, moved here from Operations |
| Admin > Price book | `/products` | same price book quotes already read from |
| Admin > Logins | `/team` | |
| Admin > Import review | `/review` | |

## What did not change

Every route above is the route that already existed. No page was rewritten, no
API touched, no database field renamed, nothing duplicated. Detail routes
(`/quotes/:id`, `/jobs/:id`, `/clients/:id`, `/companies/:id`,
`/supervisors/:id`) and the deep links `/settings?tab=business` and
`/installers?open=<id>` all still work and still light up the right sidebar
child.

Installers and Price book moved in the sidebar only. They are configuration you
set up once and read from everywhere, not daily screens, so they sit in Admin.
Installers still appear throughout Jobs and Schedule for allocation, and quotes
still read the same price book.

## Sidebar behaviour

Areas with children collapse. A section opens and its child highlights when you
are inside it, so landing on `/finance/invoices` shows Finance open with
Invoices selected and everything else quiet. You can close a section by hand.

Below `lg` the rail is replaced by a top bar and a drawer holding the same nav.
Tapping a link closes the drawer.

## Not built, on purpose

Pipeline Board, Marketing Overview / Journeys / Campaigns, and all Terra AI
functionality (Quick capture, Agents, Needs review, Activity, Ask Terra). The
Terra AI page names them so the office knows what is coming, and nothing more.
