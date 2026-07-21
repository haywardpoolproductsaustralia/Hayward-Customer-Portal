/* lib/recon/queries.ts
   Reads the three reconciliation inputs from Redis — the app never touches a
   database (same rule as every other page). Producers:

     recon:arrow_open_pos   ArrowLine[]   <- portal-sync (Arrow open-PO SQL)
     recon:as400_orders     As400Row[]    <- portal-sync (AS400 Snowflake SQL)
     recon:shipment_index   ShipmentLine[]<- /api/shipment-inbox/ingest (CDS-Net Excel)

   portal-sync writes the first two already shaped to ArrowLine / As400Row, the
   same way it writes forecast:all as ForecastRecord[]. See the portal-sync doc.
*/

import { getJSON } from "@/lib/redis";
import { buildAs400Index, type ArrowLine, type As400Row } from "./reconcile";
import { buildShipmentIndex, type ShipmentLine } from "./shipmentIngest";

export interface ReconInputs {
  arrow: ArrowLine[];
  as400Idx: ReturnType<typeof buildAs400Index>;
  shipIdx: ReturnType<typeof buildShipmentIndex>;
  counts: { arrow: number; as400: number; shipment: number };
  shipmentReceivedAt: string | null;
}

interface ShipmentMeta { receivedAt?: string; subject?: string; rows?: number; file?: string }

export async function getReconInputs(): Promise<ReconInputs> {
  const [arrow, as400, shipLines, shipMeta] = await Promise.all([
    getJSON<ArrowLine[]>("recon:arrow_open_pos"),
    getJSON<As400Row[]>("recon:as400_orders"),
    getJSON<ShipmentLine[]>("recon:shipment_index"),
    getJSON<ShipmentMeta>("recon:shipment_meta"),
  ]);

  return {
    arrow: arrow ?? [],
    as400Idx: buildAs400Index(as400 ?? []),
    shipIdx: buildShipmentIndex(shipLines ?? []),
    counts: { arrow: arrow?.length ?? 0, as400: as400?.length ?? 0, shipment: shipLines?.length ?? 0 },
    shipmentReceivedAt: shipMeta?.receivedAt ?? null,
  };
}
