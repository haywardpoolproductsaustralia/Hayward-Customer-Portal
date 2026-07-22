/*
  customer-delivery-addresses.sql — every delivery address on file, per debtor.

  WHY: a chain can order under one debtor code but ship to many branches. When
  the incoming PO's delivery block names a suburb, postcode or branch phone,
  these rows are what let the matcher confirm which account it belongs to —
  including when the branch itself has no separate debtor account.

  DELMAST is keyed RECORD_TYPE + CUSTOMER_CODE + ADDRESS_CODE (index DELMAST001).
  All char(n), so RTRIM throughout, same as DRSMAST.

  DELIVERY_ADDR1..4 are free-text address lines with no fixed meaning — the
  sync joins them and lets the matcher pattern-find suburb/postcode rather than
  assuming line 2 is always the suburb.
*/

SELECT
    RTRIM(m.CUSTOMER_CODE)     AS code,
    RTRIM(m.ADDRESS_CODE)      AS addressCode,
    RTRIM(m.DELIVERY_ADDR1)    AS addr1,
    RTRIM(m.DELIVERY_ADDR2)    AS addr2,
    RTRIM(m.DELIVERY_ADDR3)    AS addr3,
    RTRIM(m.DELIVERY_ADDR4)    AS addr4,
    RTRIM(m.CONTACT_NAME)      AS contactName,
    RTRIM(m.PHONE_NUMBER)      AS phone,
    RTRIM(m.ABN_BRANCH_CODE)   AS branchCode
FROM   DELMAST m
WHERE  RTRIM(m.CUSTOMER_CODE) <> ''
  AND  m.DELETE_ADDRESS <> 'Y'
ORDER BY m.CUSTOMER_CODE, m.ADDRESS_CODE;
