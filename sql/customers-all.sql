/*
  customers-all.sql — EVERY row in Arrow DRSMAST, for portal-sync to push into
  Redis as customerNames / customerProfiles.

  No filtering. Not by activity, not by customer type, not by the 19 portal
  organisations, not even by DELETE_CUSTOMER. Everything comes across and the
  sync job decides what to do with it — filtering in SQL is what left branch
  accounts out of Redis and made the au-orders matcher settle for the wrong
  sibling branch. DELETE_CUSTOMER is returned as a field so the matcher can
  skip deleted accounts without them vanishing from the cache.

  Schema notes that matter (CLEVAQUIP, verified against the schema script):

  * CUSTOMER_CODE char(6) is the key — unique index DRSMAST001.
  * CUSTOMER_NAME is char(30) and Arrow TRUNCATES to fit. Real branch names are
    longer than that, so what's stored is e.g. "REECE IRRIGATION & POOLS CAMPB"
    for Campbelltown and "...BERRI" for Berrimah. The name is genuinely cut in
    the database; nothing here can recover the full text, so the matcher has to
    do prefix matching on the final word. LEN() is returned per row so the sync
    can report how many names are sitting at the cap.
  * Every column is char(n), space-padded. RTRIM everywhere — a padded
    "200225    " will not equal "200225" once it is a Redis key.
  * DRSTRAN's date column is [DATE], a reserved word, hence the brackets.
*/

SELECT
    RTRIM(d.CUSTOMER_CODE)      AS code,
    RTRIM(d.CUSTOMER_NAME)      AS name,
    LEN(RTRIM(d.CUSTOMER_NAME)) AS nameLen,
    RTRIM(d.CUSTOMER_ALPHA)     AS alpha,
    RTRIM(d.CONTACT_NAME)       AS contactName,
    RTRIM(d.PHONE_NUMBER)       AS phone,
    RTRIM(d.FAX_NUMBER)         AS fax,
    RTRIM(d.STREET)             AS street,
    RTRIM(d.SUBURB)             AS suburb,
    RTRIM(d.CITY)               AS city,
    RTRIM(d.STATE)              AS state,
    RTRIM(d.POSTCODE)           AS postcode,
    RTRIM(d.AUTO_PRICE_TYPE)    AS priceType,
    RTRIM(d.PARENT_ACCOUNT)     AS parentAccount,
    RTRIM(d.CUSTOMER_TYPE)      AS customerType,
    RTRIM(d.ACCOUNT_TYPE)       AS accountType,
    RTRIM(d.STOCK_LOCATION)     AS stockLocation,
    RTRIM(d.DELETE_CUSTOMER)    AS deleteFlag,
    d.DATE_LAST_INV             AS dateLastInvoice,
    t.lastTransaction
FROM        DRSMAST d
LEFT JOIN  (SELECT CUSTOMER_CODE, MAX([DATE]) AS lastTransaction
            FROM   DRSTRAN
            GROUP  BY CUSTOMER_CODE) t
       ON   t.CUSTOMER_CODE = d.CUSTOMER_CODE
WHERE       RTRIM(d.CUSTOMER_CODE) <> ''
ORDER BY    d.CUSTOMER_CODE;
