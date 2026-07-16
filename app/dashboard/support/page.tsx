import Link from "next/link";
import { Ticket, ClipboardList, ArrowRight, ExternalLink } from "lucide-react";

// Your AU customer-facing Freshdesk portal.
const FRESHDESK_PORTAL = "hayward-supportdesk.freshdesk.com";

export const metadata = { title: "Warranty" };

const ACTIONS = [
  {
    href: `https://${FRESHDESK_PORTAL}/support/tickets/new`,
    title: "Submit a ticket",
    description: "Lodge a new warranty claim or support request.",
    icon: Ticket,
  },
  {
    href: `https://${FRESHDESK_PORTAL}/support/tickets`,
    title: "View all tickets",
    description: "Track the progress of your existing claims and requests.",
    icon: ClipboardList,
  },
];

export default function WarrantyPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-ink">Warranty</h1>
          <p className="mt-1 text-sm text-ink/60">
            Submit a warranty claim or check on an existing one.
          </p>
        </div>

        <Link
          href={`https://${FRESHDESK_PORTAL}/support/home`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink/10 px-3 py-2 text-sm text-ink/70 transition hover:bg-foam"
        >
          Freshdesk portal
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <a
              key={action.href}
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex flex-col gap-5 rounded-2xl border border-ink/10 bg-white p-6 shadow-soft transition hover:border-wave/40 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-wave/10 text-wave">
                  <Icon className="h-6 w-6" strokeWidth={2} />
                </span>
                <ArrowRight className="h-5 w-5 text-ink/30 transition group-hover:translate-x-0.5 group-hover:text-wave" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-ink">{action.title}</h2>
                <p className="mt-1 text-sm text-ink/60">{action.description}</p>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
