// Embeds Freshdesk's feedback-widget ticket form.
//
// NOTE: we deliberately do NOT iframe /support/tickets/new — Freshdesk blocks
// that page from cross-origin framing (X-Frame-Options), so it renders blank
// on portal-hayward.com. The /widgets/feedback_widget/new endpoint below is
// Freshdesk's supported embeddable form and frames fine.
//
// Requirement: the Feedback Widget must be enabled in Freshdesk
// (Admin -> Channels -> Widgets -> Feedback Form). If it's off, this endpoint
// won't render a form.

export function RaiseTicket({ portalDomain }: { portalDomain: string }) {
  const params = new URLSearchParams({
    widgetType: "embedded",
    screenshot: "no",
    searchArea: "no",
    formTitle: "Raise a ticket",
  });
  const src = `https://${portalDomain}/widgets/feedback_widget/new?${params.toString()}`;

  return (
    <div className="rounded-xl border border-ink/10 bg-white overflow-hidden">
      <iframe
        title="Raise a ticket"
        src={src}
        className="w-full"
        style={{ height: 700, border: 0 }}
      />
    </div>
  );
}
