import Link from "next/link";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { RaiseTicket } from "@/components/support/RaiseTicket";

// Your AU customer-facing Freshdesk portal.
// NOTE: this differs from the hayward9702.freshdesk.com account used by the
// API integration (lib/freshdesk.ts). Confirm which subdomain is the live
// customer portal before going wide.
const FRESHDESK_PORTAL = "hayward-supportdesk.freshdesk.com";

export const metadata = { title: "Warranty" };

export default function WarrantyPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-wave" />
            <h1 className="text-xl font-semibold text-ink">Warranty</h1>
          </div>
          <p className="mt-1 text-sm text-ink/60">
            Raise a ticket and track its progress without leaving the portal.
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

      <h2 className="mb-3 text-sm font-medium text-ink/80">Raise a ticket</h2>
      <RaiseTicket portalDomain={FRESHDESK_PORTAL} />
    </div>
  );
}
