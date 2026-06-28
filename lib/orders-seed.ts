import { createOrder, type OrderData } from "./orders";

/**
 * Realistic sample extractions so you can see and test the queue (claiming,
 * the lock, duplicate flags, low-confidence SKUs) before the email pipeline
 * is wired up. Includes one duplicate PO and one unresolved customer.
 */
export function sampleOrders(): OrderData[] {
  const now = Date.now();
  const mins = (n: number) => now - n * 60_000;

  return [
    {
      internetMessageId: "sample-0001",
      receivedAt: mins(8),
      emailWebUrl: "https://outlook.office365.com/mail/au-orders@hayward.com/sample-0001",
      fromEmail: "orders@bluewaterpools.com.au",
      fromName: "Bluewater Pools",
      debtorCode: "BLU012",
      debtorName: "Bluewater Pools Pty Ltd",
      poRef: "PO-44821",
      deliverBy: "2026-07-04",
      deliverTo: "12 Reservoir Rd, Dandenong VIC 3175",
      contact: "Dane (03 9794 0000)",
      lines: [
        { raw: "3 x TriStar VS pump 1.85kW", sku: "SP3400VSP", description: "TriStar VS Variable Speed Pump 1.85kW", qty: 3, unit: "ea", claimedPrice: null, confidence: "high" },
        { raw: "box of 25 chlorine tabs", sku: null, description: null, qty: 1, unit: "box", claimedPrice: null, confidence: "low" },
      ],
      notes: "Please ship complete — customer away next week.",
      extractionConfidence: "low",
      duplicateOf: null,
    },
    {
      internetMessageId: "sample-0002",
      receivedAt: mins(22),
      emailWebUrl: "https://outlook.office365.com/mail/au-orders@hayward.com/sample-0002",
      fromEmail: "purchasing@aquatechvic.com.au",
      fromName: "Aquatech Victoria",
      debtorCode: "AQT004",
      debtorName: "Aquatech Victoria",
      poRef: "4501-2207",
      deliverBy: null,
      deliverTo: "Warehouse pickup",
      contact: null,
      lines: [
        { raw: "10x AquaRite T-15 cell", sku: "GLX-CELL-15", description: "AquaRite Turbo Cell T-15", qty: 10, unit: "ea", claimedPrice: 389.0, confidence: "high" },
        { raw: "2 x Sense and Dispense kits", sku: "HLAQUATROL", description: "Sense and Dispense AquaTrol Kit", qty: 2, unit: "kit", claimedPrice: null, confidence: "high" },
      ],
      notes: "Customer quoted $389 ea on cells — please confirm against contract.",
      extractionConfidence: "high",
      duplicateOf: null,
    },
    {
      internetMessageId: "sample-0003",
      receivedAt: mins(35),
      emailWebUrl: "https://outlook.office365.com/mail/au-orders@hayward.com/sample-0003",
      fromEmail: "orders@bluewaterpools.com.au",
      fromName: "Bluewater Pools",
      debtorCode: "BLU012",
      debtorName: "Bluewater Pools Pty Ltd",
      poRef: "PO-44821", // same debtor + PO as sample-0001 => duplicate
      deliverBy: "2026-07-04",
      deliverTo: "12 Reservoir Rd, Dandenong VIC 3175",
      contact: "Dane",
      lines: [
        { raw: "3 x TriStar VS pump 1.85kW", sku: "SP3400VSP", description: "TriStar VS Variable Speed Pump 1.85kW", qty: 3, unit: "ea", claimedPrice: null, confidence: "high" },
      ],
      notes: "Resending in case the first didn't arrive.",
      extractionConfidence: "high",
      duplicateOf: null, // createOrder() will detect and fill this in
    },
    {
      internetMessageId: "sample-0004",
      receivedAt: mins(51),
      emailWebUrl: "https://outlook.office365.com/mail/au-orders@hayward.com/sample-0004",
      fromEmail: "j.smith@gmail.com",
      fromName: "John Smith",
      debtorCode: null, // sender doesn't resolve to a debtor — flag, don't guess
      debtorName: null,
      poRef: null,
      deliverBy: null,
      deliverTo: "Frankston area",
      contact: "0412 345 678",
      lines: [
        { raw: "one pool pump, the quiet one you sell", sku: null, description: null, qty: 1, unit: "ea", confidence: "low", claimedPrice: null },
      ],
      notes: "Possible new / non-account customer. Needs a human to identify.",
      extractionConfidence: "low",
      duplicateOf: null,
    },
  ];
}

export async function seedSampleOrders(): Promise<number> {
  const samples = sampleOrders();
  for (const s of samples) await createOrder(s);
  return samples.length;
}
