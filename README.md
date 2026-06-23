# Hayward Customer Portal

The actual customer-facing portal: Stock, Orders, and Pricing pages, gated
by Clerk Organizations, reading from the Redis cache that `portal-sync`
keeps fresh every 15 minutes.

## Architecture in one paragraph

Nothing in this app talks to Arrow SQL or Snowflake directly. It only
reads from Upstash Redis (populated by `portal-sync`, which runs on
AZ-Grey) and Clerk (for who's logged in and which organization they're
viewing). A logged-in user's Clerk Organization name maps to one of the
18 customer groups; if their membership has a `branchCode` set, they see
just that one Arrow code, otherwise they see every code in the group
(head office view).

## One critical setup step before this works at all: custom session claims

`lib/access.ts` reads two pieces of information off the Clerk session
token that **aren't there by default** - they have to be added manually:

1. Go to the Clerk Dashboard -> **Sessions** -> **Customize session token**
2. Add these two claims:
   - `orgName` → `{{organization.name}}`
   - `branchCode` → `{{organization_membership.public_metadata.branchCode}}`
3. Save

Without this step, every page will behave as if no organization is
selected, even when one clearly is in the switcher.

## Setting a branch's customer code

Branch logins need a `branchCode` set on their **Organization
Membership** (not the Organization itself, not the user). This can only
be done through Clerk's Backend API - there's no dashboard field for it.
That's a one-off script, written when we get to the pilot (Phase 7), not
something to do by hand per branch.

Members **without** a `branchCode` set are treated as head office for
their organization and see every customer code in that group.

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in:
   - Clerk's Publishable + Secret keys (Configure -> API Keys)
   - The same Upstash Redis REST URL + token used in `portal-sync/.env`
3. `npm run dev` and open `http://localhost:3000`

## Known limitations (intentional, not bugs)

- **Category names aren't wired up yet.** `STKMAST.STOCK_CATEGORY` is
  just a bare 2-character code (e.g. `AC`, `20`), not a friendly label
  like "1.SS PUMPS" the way the existing Pricing Tool displays them. A
  full schema search turned up no obvious lookup table for this, so
  before building category filtering, worth running:
  ```sql
  SELECT STOCK_CODE, STOCK_CATEGORY, STOCK_ALPHA, STOCK_NAME_2, STOCK_FILLER
  FROM STKMAST
  WHERE STOCK_CODE = '1B-COMCABLEF'
  ```
  (a real SKU known to show under "1.SS PUMPS" in the Pricing Tool) to
  see whether the friendly name is hiding in `STOCK_FILLER` or comes from
  somewhere else entirely.
- **No product photos** - confirmed none exist anywhere to source from,
  so the Catalog page intentionally doesn't try to fake them with stock
  imagery or icons.
- **The Catalog page prices only the items currently visible on screen**
  (one page at a time, ~24 items), not all ~5,166 SKUs at once - pricing
  every SKU upfront would mean computing thousands of quantity-break
  calculations nobody's looking at yet.
- **The Stock page loads everything in one shot rather than searching
  on-demand.** `portal-sync` writes a consolidated `stock:all` key
  alongside the per-SKU `stock:{sku}` keys specifically for this - one
  Redis read instead of fanning out across 5,000+ keys. The page filters
  client-side as you type, capped at showing 200 rows at once so the
  table itself stays fast even though all ~5,166 SKUs are loaded in
  memory. If the SKU count grows by an order of magnitude, this approach
  will need revisiting (probably real server-side search at that point).
- **Head-office pricing assumes one shared price type per group.** If a
  group's branches ever turn out to have genuinely different negotiated
  rates, the pricing API will need to resolve price type per-branch
  rather than from one representative code.
- **Manuals page is a placeholder.** Blob storage for tech manuals
  hasn't been built yet.
- **Order status labels are a best guess**, not confirmed against Arrow's
  actual documentation for `STATUS_FLAG` - see `portal-sync/README.md`.

## Deploying

This is built to deploy the same way as your other tools: push to a
GitHub repo, connect it to Vercel, set the environment variables in
Vercel's project settings (same four+three as `.env.example`), done.
Vercel auto-detects Next.js, no build configuration needed.

Once deployed, come back to the Clerk Dashboard and add the production
URL to the allowed origins if Clerk's setup wizard doesn't do it
automatically - it usually flags this itself if something's missing.
