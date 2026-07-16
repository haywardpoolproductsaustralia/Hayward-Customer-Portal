"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, ExternalLink, Inbox } from "lucide-react";

const FRESHDESK_DOMAIN =
  process.env.NEXT_PUBLIC_FRESHDESK_DOMAIN ?? "hayward9702.freshdesk.com";

type Ticket = {
  id: number;
  subject: string;
  status: number;
  priority: number;
  type: string | null;
  created_at: string;
  updated_at: string;
};

const STATUS: Record<number, { label: string; className: string }> = {
  2: { label: "Open", className: "bg-splash/15 text-deep" },
  3: { label: "Pending", className: "bg-amber/25 text-sunset" },
  4: { label: "Resolved", className: "bg-wave/10 text-wave" },
  5: { label: "Closed", className: "bg-ink/10 text-ink/60" },
};

// These map to Freshdesk ticket "types". Add matching types in
// Freshdesk (Admin → Ticket Fields → Type) so routing/reporting works —
// especially "Warranty Claim".
const TICKET_TYPES = [
  "General Question",
  "Order Issue",
  "Technical Support",
  "Warranty Claim",
];

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function SupportCenter() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/support/tickets");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTickets(data.tickets ?? []);
    } catch {
      setListError("Couldn't load your tickets. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => setShowForm((s) => !s)}
          className="inline-flex items-center gap-2 rounded-lg bg-wave px-4 py-2 text-sm font-medium text-foam transition hover:bg-deep"
        >
          <Plus className="h-4 w-4" />
          {showForm ? "Close" : "New ticket"}
        </button>
        <button
          onClick={loadTickets}
          className="inline-flex items-center gap-2 rounded-lg border border-ink/10 px-3 py-2 text-sm text-ink/70 transition hover:bg-foam"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {showForm && (
        <NewTicketForm
          onCreated={() => {
            setShowForm(false);
            loadTickets();
          }}
        />
      )}

      <div className="rounded-xl border border-ink/10 overflow-hidden">
        <div className="border-b border-ink/10 bg-foam/40 px-5 py-3 text-sm font-medium text-ink/80">
          Your tickets
        </div>

        {loading ? (
          <div className="divide-y divide-ink/5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="animate-pulse px-5 py-4">
                <div className="h-4 w-2/3 rounded bg-ink/10" />
                <div className="mt-2 h-3 w-1/3 rounded bg-ink/5" />
              </div>
            ))}
          </div>
        ) : listError ? (
          <div className="px-5 py-8 text-center text-sm text-coral">
            {listError}
          </div>
        ) : tickets.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
            <Inbox className="h-8 w-8 text-ink/30" />
            <p className="text-sm text-ink/60">
              No tickets yet. Raise one above and it&apos;ll appear here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-ink/5">
            {tickets.map((t) => {
              const status = STATUS[t.status] ?? {
                label: "—",
                className: "bg-ink/10 text-ink/60",
              };
              return (
                <li key={t.id}>
                  <a
                    href={`https://${FRESHDESK_DOMAIN}/support/tickets/${t.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between gap-4 px-5 py-4 transition hover:bg-foam/50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {t.subject}
                        </span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-ink/30" />
                      </div>
                      <div className="mt-1 text-xs text-ink/50">
                        #{t.id}
                        {t.type ? ` · ${t.type}` : ""} · {fmtDate(t.created_at)}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewTicketForm({ onCreated }: { onCreated: () => void }) {
  const [subject, setSubject] = useState("");
  const [type, setType] = useState(TICKET_TYPES[0]);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!subject.trim() || !description.trim()) {
      setError("Please add a subject and a description.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, description, type }),
      });
      if (!res.ok) throw new Error();
      setSubject("");
      setDescription("");
      setType(TICKET_TYPES[0]);
      onCreated();
    } catch {
      setError("Something went wrong creating your ticket. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-wave focus:ring-2 focus:ring-wave/20";

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-xl border border-ink/10 bg-foam/40 p-5"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium text-ink/70">
            Subject
          </label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Brief summary of the issue"
            className={inputClass}
            maxLength={200}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink/70">
            Type
          </label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={inputClass}
          >
            {TICKET_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink/70">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Include order/invoice numbers, product SKUs, and any relevant detail."
          rows={5}
          className={inputClass}
        />
      </div>

      {error && <p className="text-sm text-coral">{error}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center gap-2 rounded-lg bg-wave px-4 py-2 text-sm font-medium text-foam transition hover:bg-deep disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "Submitting…" : "Submit ticket"}
        </button>
      </div>
    </form>
  );
}
