/* ============================================================================
   Forecasting feed for the Hayward portal
   ----------------------------------------------------------------------------
   portal-sync (AZ-Grey) runs these two queries against Arrow (CLEVAQUIP on
   Blue2), then in Node joins them per SKU, calls lib/forecast.ts, and writes
   `forecast:all` + `forecast:meta` to Upstash Redis. The portal itself never
   runs this - it only reads the Redis keys, exactly like every other page.

   Two things to CONFIRM in your environment before trusting the numbers:
     1. Warehouse location codes. The portal rule is "only 1-MEL and 2-MEL".
        Verify the exact stored strings (char(6), so possibly padded):
          SELECT DISTINCT STOCK_LOCATION FROM LOCMAST ORDER BY 1;
        and adjust the IN (...) list in Query 2 to match.
     2. Sales transaction types. We net invoices against credits the same way
        your Arrow_SALES_BY_TERRITORY view does: DRINV positive, DRCDT negative,
        restricted to stock-movement rows (SIT = 'S'). If you book sales under
        any other trans type, add it to the CASE/IN in Query 1.
   ========================================================================== */


/* ----------------------------------------------------------------------------
   QUERY 1 — Monthly demand series (long format), last 36 months.
   One row per SKU per calendar month with a non-zero net movement. Node fills
   the gap months with zero when it builds the array - keeping zero months out
   of SQL keeps this fast. Demand = ALL invoiced sales (national), not just the
   two Melbourne warehouses: you are forecasting how much the product sells,
   then deciding where to hold it. The 1-MEL/2-MEL rule applies to the on-hand
   position in Query 2, not to demand.
   -------------------------------------------------------------------------- */
DECLARE @MonthsBack int = 36;

SELECT
    t.STOCK_CODE                                   AS sku,
    YEAR(t.[DATE])                                 AS yr,
    MONTH(t.[DATE])                                AS mth,
    SUM(CASE WHEN t.TRANS_TYPE = 'DRCDT'
             THEN -t.QUANTITY ELSE t.QUANTITY END) AS qty
FROM dbo.STKTRAN AS t
WHERE t.SIT = 'S'
  AND t.TRANS_TYPE IN ('DRINV', 'DRCDT')
  AND t.[DATE] >= DATEADD(MONTH, -@MonthsBack, CAST(GETDATE() AS date))
GROUP BY t.STOCK_CODE, YEAR(t.[DATE]), MONTH(t.[DATE])
HAVING SUM(CASE WHEN t.TRANS_TYPE = 'DRCDT'
                THEN -t.QUANTITY ELSE t.QUANTITY END) <> 0
ORDER BY t.STOCK_CODE, yr, mth;


/* ----------------------------------------------------------------------------
   QUERY 2 — Per-SKU master + live stock position.
   AVERAGE_COST is the official cost (Joe). Position fields are summed across
   ONLY 1-MEL + 2-MEL. ON_ORDER_QTY here is Arrow's running figure; if you want
   PO *timing* later, join PORTRAN open lines (QUANTITY - RECEIVED_QTY > 0) on
   DELIVERY_DATE - left out of v1 to keep the position a single clean number.
   -------------------------------------------------------------------------- */
SELECT
    s.STOCK_CODE                                   AS sku,
    LTRIM(RTRIM(s.STOCK_ALPHA + s.STOCK_FILLER))   AS name,
    LTRIM(RTRIM(s.STOCK_CATEGORY))                 AS stockCategory,
    LTRIM(RTRIM(s.SUPPLIER_CODE))                  AS supplierCode,
    LTRIM(RTRIM(c.CREDITOR_NAME))                  AS supplierName,
    LTRIM(RTRIM(s.SUPPLIER_STOCK))                 AS supplierStock,
    s.LEAD_TIME_DAYS                               AS leadTimeDays,
    s.AVERAGE_COST                                 AS avgCost,
    /* position - 1-MEL + 2-MEL only */
    ISNULL(loc.onHand, 0)                          AS onHand,
    ISNULL(loc.onOrder, 0)                         AS onOrder,
    ISNULL(loc.allocated, 0)                       AS allocated,
    ISNULL(loc.backordered, 0)                     AS backordered,
    ISNULL(loc.arrowReorderQty, 0)                 AS arrowReorderQty,
    ISNULL(loc.arrowMinimumQty, 0)                 AS arrowMinimumQty
FROM dbo.STKMAST AS s
LEFT JOIN dbo.CRSMAST AS c
       ON c.CREDITOR_CODE = s.SUPPLIER_CODE
LEFT JOIN (
    SELECT
        l.STOCK_CODE,
        SUM(l.ON_HAND_QTY)    AS onHand,
        SUM(l.ON_ORDER_QTY)   AS onOrder,
        SUM(l.ALLOCATED_QTY)  AS allocated,
        SUM(l.BACKORDER_QTY)  AS backordered,
        SUM(l.REORDER_QTY)    AS arrowReorderQty,
        SUM(l.MINIMUM_QTY)    AS arrowMinimumQty
    FROM dbo.LOCMAST AS l
    WHERE l.STOCK_LOCATION IN ('1-MEL', '2-MEL')   -- confirm exact codes (see header)
    GROUP BY l.STOCK_CODE
) AS loc ON loc.STOCK_CODE = s.STOCK_CODE
WHERE s.DELETE_STOCK <> 'Y'
ORDER BY s.STOCK_CODE;
