import Link from "next/link";
import { ExternalLink, LifeBuoy } from "lucide-react";
import { SupportCenter } from "@/components/support/SupportCenter";

// To rename this to "Warranty": change the <h1> text below, the metadata
// title, and swap LifeBuoy for ShieldCheck (and the matching Sidebar item).
const FRESHDESK_DOMAIN =
  process.env.NEXT_PUBLIC_FRESHDESK_DOMAIN ?? "hayward9702.freshdesk.com";

export const metadata = { title: "Support" };

export default function SupportPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <LifeBuoy className="h-5 w-5 text-wave" />
            <h1 className="text-xl font-semibold text-ink">Support</h1>
          </div>
          <p className="mt-1 text-sm text-ink/60">
            Raise a ticket and track its progress without leaving the portal.
          </p>
        </div>

        <Link
          href={`https://${FRESHDESK_DOMAIN}/support/home`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-ink/10 px-3 py-2 text-sm text-ink/70 transition hover:bg-foam"
        >
          Knowledge base
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>

      <SupportCenter />
    </div>
  );
}
