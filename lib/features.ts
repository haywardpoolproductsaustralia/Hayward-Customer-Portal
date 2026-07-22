// Feature flags.
//
// PORTAL_ORDERS_ENABLED turns customer-facing order entry on and off as one
// switch: the "Convert to order" panel on the quote builder, the staff Portal
// orders queue and its nav item, and the submit endpoint behind them.
//
// Turned OFF 22 Jul 2026 while the pricing base is settled — quote prices for
// some categories did not reconcile against what Arrow actually bills, and
// taking real orders at a price we can't yet stand behind is the one failure
// worth avoiding. Nothing is deleted; the pso:* records, the APIs and the
// queue page all remain. Set this back to true to restore the feature exactly
// as it was.
//
// The submit endpoint is gated too, deliberately. Hiding only the button would
// leave a live route writing orders into a queue nobody is looking at.
export const PORTAL_ORDERS_ENABLED = false;
