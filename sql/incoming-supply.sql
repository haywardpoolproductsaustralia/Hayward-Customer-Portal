/* ============================================================================
   Incoming supply feed (customer-facing) for the Hayward portal
   ----------------------------------------------------------------------------
   Shows distributors how much Hayward AU has ON ORDER from its suppliers for a
   SKU, and when it's expected. portal-sync runs this, aggregates per SKU, and
   FOLDS the result into the existing stock entry it already writes
   (`stock:{sku}` and `stock:all`) under an `incoming` key - no new Redis key,
   no new API. The Products page and detail modal then render it automatically.

   COMMERCIAL BOUNDARY - this is shown to customers, so the query deliberately
   returns quantity + expected date ONLY. Do NOT surface supplier/creditor,
   cost price, or PO number to the customer side.

   Open line = ordered but not yet fully received:
       remaining = QUANTITY - RECEIVED_QTY  (> 0)
   STATUS_FLAG filter: exclude cancelled/closed POs. The exact open/closed codes
   aren't in the DDL - confirm against your data, e.g.:
       SELECT STATUS_FLAG, COUNT(*) FROM PORMAST GROUP BY STATUS_FLAG;
   then adjust the NOT IN (...) list below. Default assumes 'X'/'C' = closed.
   ========================================================================== */

SELECT
    t.STOCK_CODE                          AS sku,
    CAST(t.DELIVERY_DATE AS date)         AS eta,
    SUM(t.QUANTITY - t.RECEIVED_QTY)      AS qty
FROM dbo.PORTRAN AS t
INNER JOIN dbo.PORMAST AS h
        ON h.ORDER_NUMBER = t.ORDER_NUMBER
WHERE (t.QUANTITY - t.RECEIVED_QTY) > 0
  AND ISNULL(h.STATUS_FLAG, '') NOT IN ('X', 'C')   -- confirm codes (see header)
  AND ISNULL(t.STATUS_FLAG, '') NOT IN ('X', 'C')
GROUP BY t.STOCK_CODE, CAST(t.DELIVERY_DATE AS date)
HAVING SUM(t.QUANTITY - t.RECEIVED_QTY) > 0
ORDER BY t.STOCK_CODE, eta;
