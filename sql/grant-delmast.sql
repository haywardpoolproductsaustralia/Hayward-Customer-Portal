/*
  grant-delmast.sql — one-line permission grant for the portal-sync login.

  WHY
  DELMAST holds each customer's delivery addresses. The au-orders matcher uses
  them to identify a branch that ships to its own site under a parent account —
  the delivery block on an incoming purchase order often matches one of these
  rather than the account's registered address.

  NOT REQUIRED TO RUN. Every account already carries its own street, suburb,
  postcode and phone in DRSMAST, and that is what the matcher primarily runs
  on. Both scripts skip DELMAST with a warning if this grant isn't in place.
  This grant improves branch-level accuracy for chains; it doesn't unblock
  anything.

  Read-only, on one table, for the existing read-only login. Nothing else
  changes.
*/

USE CLEVAQUIP;
GO

GRANT SELECT ON dbo.DELMAST TO portal_sync_readonly;
GO

-- Verify it took effect.
SELECT TOP 5
    RTRIM(CUSTOMER_CODE)  AS code,
    RTRIM(ADDRESS_CODE)   AS addressCode,
    RTRIM(DELIVERY_ADDR1) AS addr1,
    RTRIM(PHONE_NUMBER)   AS phone
FROM   dbo.DELMAST
WHERE  DELETE_ADDRESS <> 'Y';
GO

-- How much this actually adds: accounts with at least one delivery address
-- on file, versus the 3,169 in DRSMAST.
SELECT COUNT(DISTINCT RTRIM(CUSTOMER_CODE)) AS accountsWithDeliveryAddresses
FROM   dbo.DELMAST
WHERE  DELETE_ADDRESS <> 'Y';
GO
