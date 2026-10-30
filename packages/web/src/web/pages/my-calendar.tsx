import { Page } from "../components/layout";
import { CalendarCard } from "../components/calendar-card";

/** My calendar. Open to Office and Admin, so each person links their own Google calendar. */
export default function MyCalendarPage() {
  return (
    <Page title="My calendar" subtitle="Be booked for measures, site visits and jobs. Bookings with you check your own Google calendar.">
      <div className="max-w-3xl">
        <CalendarCard />
      </div>
    </Page>
  );
}
