/* lib/recon/queries.ts
   Data access for the two databases. The SQL lives here as strings; the two
   exported functions return typed rows the engine understands.

   IMPORTANT — connections:
   - Snowflake is cloud-reachable from Vercel. Wire runSnowflake() to the
     Snowflake client you already use (snowflake-sdk), or reuse an existing
     helper if the portal already queries Snowflake elsewhere.
   - Arrow (SQL Server / CLEVAQUIP) is almost certainly on-prem and NOT
     reachable from a Vercel function. Point getArrowOpenPos() at the SAME
     connection path your pricing-engine / allocation pages already use to
     read Arrow. If those run on-prem or via a gateway, this must too.
     (If Arrow is mirrored into Snowflake via your gateway, just run the Arrow
     SQL through runSnowflake() against the mirrored tables and you're done.)
*/

import type { ArrowLine, As400Row } from "./reconcile";

/* ----------------------------- Arrow (SQL Server) ----------------------------- */
export const ARROW_OPEN_POS_SQL = /* sql */ `
WITH ln AS (
  SELECT
    RTRIM(l.ORDER_NUMBER)               AS PO_NUMBER,
    RTRIM(l.STOCK_CODE)                 AS ARROW_STOCK_CODE,
    NULLIF(RTRIM(s.SUPPLIER_STOCK), '') AS SUPPLIER_SKU,
    RTRIM(s.STOCK_NAME_2)               AS DESCRIPTION,
    l.QUANTITY, l.RECEIVED_QTY, l.COST_PRICE, l.ORDER_LINE, l.DELIVERY_DATE
  FROM dbo.PORTRAN l
  LEFT JOIN dbo.STKMAST s ON RTRIM(s.STOCK_CODE) = RTRIM(l.STOCK_CODE)
),
agg AS (
  SELECT
    PO_NUMBER, ARROW_STOCK_CODE,
    MAX(SUPPLIER_SKU) AS SUPPLIER_SKU, MAX(DESCRIPTION) AS DESCRIPTION,
    SUM(QUANTITY) AS QTY_ORDERED, SUM(RECEIVED_QTY) AS QTY_RECEIVED,
    SUM(QUANTITY) - SUM(RECEIVED_QTY) AS QTY_OUTSTANDING,
    MAX(COST_PRICE) AS UNIT_COST, MIN(ORDER_LINE) AS FIRST_LINE,
    MIN(DELIVERY_DATE) AS LINE_REQUESTED_DATE, COUNT(*) AS SPLIT_ROWS
  FROM ln GROUP BY PO_NUMBER, ARROW_STOCK_CODE
)
SELECT
  a.PO_NUMBER, a.ARROW_STOCK_CODE, a.SUPPLIER_SKU, a.DESCRIPTION,
  RTRIM(h.CREDITOR_CODE) AS CREDITOR_CODE,
  a.QTY_ORDERED, a.QTY_RECEIVED, a.QTY_OUTSTANDING, a.UNIT_COST,
  h.ORDER_DATE AS PO_ORDER_DATE, h.DELIVERY_DATE AS PO_REQUESTED_DATE,
  a.LINE_REQUESTED_DATE, a.SPLIT_ROWS
FROM agg a
JOIN dbo.PORMAST h ON RTRIM(h.ORDER_NUMBER) = a.PO_NUMBER
WHERE a.QTY_OUTSTANDING > 0
  AND h.ORDER_DATE >= DATEADD(MONTH, -12, CAST(GETDATE() AS date))
ORDER BY h.ORDER_DATE DESC, a.PO_NUMBER, a.ARROW_STOCK_CODE;
`;

/* ----------------------------- AS400 (Snowflake) ----------------------------- */
export const AS400_ORDERS_SQL = /* sql */ `
SELECT
  so.CUSTOMER_PURCHASE_ORDER_REF AS PO_NUMBER,
  sol.ITEM_REF                   AS AS400_CODE,
  SUM(CASE WHEN sol.IS_CANCELLED THEN 0 ELSE sol.QUANTITY_ORDERED END) AS AS400_ORDERED_QTY,
  SUM(sol.QUANTITY_SHIPPED)      AS AS400_SHIPPED_QTY,
  MIN(sol.PROMISE_DATE)          AS PROMISE_DATE,
  MAX(CASE WHEN sol.IS_CANCELLED THEN 1 ELSE 0 END) AS ANY_CANCELLED,
  MIN(so.ORDER_REF)              AS US_SALES_ORDER,
  MIN(so.INVENTORY_SITE_REF)     AS LOCATION
FROM EDW_DB.SALES.SALES_ORDER so
JOIN EDW_DB.SALES.SALES_ORDER_LINE sol ON sol.SALES_ORDER_ID = so.ID
WHERE so.LEGAL_ENTITY_REF IN ('1','4')
  AND so.CUSTOMER_PURCHASE_ORDER_REF REGEXP '^[0-9]{6}$'
  AND sol.ITEM_REF IS NOT NULL
  AND so.ORDER_DATE >= DATEADD(month, -12, CURRENT_DATE())
GROUP BY so.CUSTOMER_PURCHASE_ORDER_REF, sol.ITEM_REF;
`;

/* --------------------------- connection seams ---------------------------
   Replace the bodies below with your real clients. Signatures are all you
   need to keep. Return an array of plain row objects keyed by column name.  */

async function runArrow(sql: string): Promise<any[]> {
  // TODO: reuse the SQL Server connection your pricing/allocation pages use.
  // Example with `mssql`:
  //   const sql = await import("mssql");
  //   const pool = await sql.connect({
  //     server: process.env.ARROW_SQL_SERVER!, database: "CLEVAQUIP",
  //     user: process.env.ARROW_SQL_USER!, password: process.env.ARROW_SQL_PASSWORD!,
  //     options: { encrypt: true, trustServerCertificate: true },
  //   });
  //   return (await pool.request().query(sql)).recordset;
  throw new Error("runArrow not wired — point this at your existing Arrow connection.");
}

async function runSnowflake(sql: string): Promise<any[]> {
  // TODO: wire to snowflake-sdk (or an existing Snowflake helper).
  // Example with `snowflake-sdk`:
  //   const snowflake = (await import("snowflake-sdk")).default;
  //   const conn = snowflake.createConnection({
  //     account: process.env.SNOWFLAKE_ACCOUNT!, username: process.env.SNOWFLAKE_USER!,
  //     password: process.env.SNOWFLAKE_PASSWORD!, warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  //     role: process.env.SNOWFLAKE_ROLE, database: "EDW_DB",
  //   });
  //   await new Promise<void>((res, rej) => conn.connect(e => e ? rej(e) : res()));
  //   return await new Promise((res, rej) =>
  //     conn.execute({ sqlText: sql, complete: (e, _s, rows) => e ? rej(e) : res(rows ?? []) }));
  throw new Error("runSnowflake not wired — point this at your Snowflake client.");
}

/* --------------------------- typed fetchers --------------------------- */
const num = (v: unknown) => (v == null ? 0 : Number(v));
const iso = (v: unknown) =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export async function getArrowOpenPos(): Promise<ArrowLine[]> {
  const rows = await runArrow(ARROW_OPEN_POS_SQL);
  return rows.map((r) => ({
    po: String(r.PO_NUMBER),
    line: num(r.FIRST_LINE) || 1,
    arrowStock: String(r.ARROW_STOCK_CODE),
    supplierSku: r.SUPPLIER_SKU ? String(r.SUPPLIER_SKU) : "",
    description: r.DESCRIPTION ?? null,
    creditor: r.CREDITOR_CODE ?? null,
    qtyOrdered: num(r.QTY_ORDERED),
    qtyReceived: num(r.QTY_RECEIVED),
    qtyOutstanding: num(r.QTY_OUTSTANDING),
    requestedDate: iso(r.LINE_REQUESTED_DATE) ?? iso(r.PO_REQUESTED_DATE),
  }));
}

export async function getAs400Orders(): Promise<As400Row[]> {
  const rows = await runSnowflake(AS400_ORDERS_SQL);
  return rows.map((r) => ({
    poNumber: String(r.PO_NUMBER),
    as400Code: String(r.AS400_CODE),
    orderedQty: num(r.AS400_ORDERED_QTY),
    shippedQty: num(r.AS400_SHIPPED_QTY),
    promiseDate: iso(r.PROMISE_DATE),
    anyCancelled: num(r.ANY_CANCELLED) === 1,
    usSalesOrder: r.US_SALES_ORDER ? String(r.US_SALES_ORDER) : null,
    location: r.LOCATION ? String(r.LOCATION) : null,
  }));
}
