# Forecasting — design & methodology

This page forecasts **demand** for each SKU and turns it into a concrete
**replenishment** recommendation: how many to buy, when, and what it costs. It
is internal supply-side planning — it shows official cost, supplier, and buy
quantities — so it lives behind the same staff-only gate as Warehouse
(`access.isAggregate`) and is never visible to distributor logins.

> If what you actually wanted was *customer-facing* forecasting (showing each
> distributor their own projected purchasing from their order history), that's
> a different, simpler page — say the word and it's a small variant of this.

Everything here fits the portal's existing rule: **nothing in the app touches
Arrow SQL.** `portal-sync` on AZ-Grey runs the SQL, computes the forecasts in
Node, and writes `forecast:all` + `forecast:meta` to Redis. The page reads
those keys exactly like the Stock page reads `stock:all`.

```
Arrow (Blue2)  ──SQL──►  portal-sync (AZ-Grey)  ──►  Upstash Redis  ──►  portal page
 STKTRAN                  lib/forecast.ts engine       forecast:all        /dashboard/forecast
 STKMAST/LOCMAST          (classify → forecast →        forecast:meta
 CRSMAST                   replenish)
```

---

## 1. The data

| Need | Source | Notes |
|---|---|---|
| Demand history | `STKTRAN` (`SIT='S'`, `DRINV` − `DRCDT`) | National invoiced sales, credits netted — same logic as your `Arrow_SALES_BY_TERRITORY` view. 36 months. |
| On-hand position | `LOCMAST` @ `1-MEL` + `2-MEL` | `ON_HAND + ON_ORDER − ALLOCATED − BACKORDER` = inventory position. |
| Lead time, cost | `STKMAST.LEAD_TIME_DAYS`, `STKMAST.AVERAGE_COST` | Average cost is the official cost. |
| Supplier | `STKMAST.SUPPLIER_CODE` → `CRSMAST`, `SUPPLIER_STOCK` | For grouping buys / container building. |
| Arrow's own settings | `LOCMAST.MINIMUM_QTY`, `REORDER_QTY` | Shown alongside, so you can see where the static min has drifted from a seasonal reorder point. |

`STKMAST` / `LOCMAST` also carry `OLD_MTH1_SALES … OLD_MTH12_SALES` (a rolling
12-month quantity history). It's a fine fast cross-check, but we build the
series from dated `STKTRAN` rows instead — that gives 2–3 full years, which is
what seasonality needs.

---

## 2. Why classification comes first

A 5,000-SKU catalogue is not one demand pattern. A variable-speed pump sells
every month; a spare impeller sells four times a year. One forecasting method
across both is the most common planning mistake. We classify each SKU on two
axes (Syntetos–Boylan–Croston):

- **ADI** — average interval between sales (how *often* it sells)
- **CV²** — variability of the quantity *when* it sells (how *spiky*)

| | CV² low (steady size) | CV² high (spiky size) |
|---|---|---|
| **ADI low** (sells often) | **Smooth** → Seasonal | **Erratic** → Seasonal |
| **ADI high** (sells rarely) | **Intermittent** → Croston/SBA | **Lumpy** → Croston/SBA |

The page shows each SKU's bucket as a chip, so you can see *why* it's forecast
the way it is.

---

## 3. The methods

**Seasonal baseline** (smooth/erratic). Pool gear is the textbook seasonal
case: demand peaks Oct–Mar (southern-hemisphere summer) and collapses through
winter. A flat moving average under-forecasts every spring and over-forecasts
every autumn. So we:

1. Build a **seasonal index** per calendar month from the multi-year history
   (mean-normalised to 1.0), shrunk toward 1.0 when there's under ~2 years of
   evidence so one freak month can't pin a wild swing on a SKU.
2. **Deseasonalise** the history, read a **level** (last 3 months) and a
   **clamped trend** (±5%/month max, so nothing runs away).
3. **Re-apply** the seasonal shape forward.

Plain enough to explain in a sentence — "recent run-rate, shaped by your normal
year" — and it doesn't break on zero months the way multiplicative
Holt-Winters does.

**Croston / SBA** (intermittent/lumpy). Forecasts demand *size* and the
*interval* between demands separately, then a per-period rate = size ÷ interval.
SBA adds the `(1 − α/2)` de-bias correction Croston is known to need. A moving
average over mostly-zero months is hopeless here; this isn't.

---

## 4. From forecast to a buy decision

A forecast nobody acts on is a chart. The useful output is the buy:

```
inventory position = on hand + on order − allocated − backordered
demand over lead time = monthly forecast × (lead time + review period) / 30
safety stock = z × σ × √(lead-time window)        z = 1.65 ≈ 95% service
reorder point (ROP) = demand over lead time + safety stock
  if position < ROP:  suggested buy = (ROP + a few months' cover) − position
  else:               no action
```

Safety stock scales with both demand variability **and** the square root of the
lead-time window — the longer and lumpier the resupply (and a lot of this is
imported on long lead times), the more buffer a service level costs. **Cover
months** = position ÷ monthly forecast is the urgency sort: lowest cover floats
to the top.

**Container building.** Imported pool gear is bought to fill a container, not
one SKU at a time. The Containers view groups every suggested buy by supplier
and totals it at cost against a target you set — when a supplier's accumulated
buys reach the target, it's flagged ready. The container/FCL convention itself
matches the `CONTAINER`/`FCL` detection already in the Warehouse code.

**Accuracy.** Each SKU is back-tested by holding out the last 3 months and
forecasting them from the rest. We report WMAPE (error %) and **bias** — bias
matters more for inventory: a method that's 20% off but unbiased self-corrects;
one that consistently runs low quietly bleeds you into stockouts. The detail
panel flags "runs low / runs high".

---

## 5. portal-sync glue

Add a step to the existing sync. It runs the two queries in
`sql/forecast-demand-series.sql`, then:

```js
import { buildForecast, replenishment, backtest } from '../lib/forecast';

const HISTORY_MONTHS = 36;
const HORIZON = 6;
const SERVICE_Z = 1.65;       // ~95%
const REVIEW_DAYS = 14;

// seriesRows = Query 1 (long), masterRows = Query 2 (one per SKU)
const byKey = new Map();      // `${sku}` -> { 'YYYY-M': qty }
for (const r of seriesRows) {
  if (!byKey.has(r.sku)) byKey.set(r.sku, {});
  byKey.get(r.sku)[`${r.yr}-${r.mth}`] = Number(r.qty);
}

// dense month axis: oldest -> newest, zero-filled
const now = new Date();
const axis = [];
for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  axis.push({ ym: `${d.getFullYear()}-${d.getMonth() + 1}`, month: d.getMonth() });
}
const monthOfFirst = axis[0].month;

const records = masterRows.map((m) => {
  const months = byKey.get(m.sku) ?? {};
  const series = axis.map((a) => months[a.ym] ?? 0);

  const f = buildForecast(series, monthOfFirst, HORIZON);
  const rep = replenishment({
    monthlyForecast: f.monthlyForecastAvg,
    monthlyStd: f.monthlyStd,
    onHand: m.onHand, onOrder: m.onOrder,
    allocated: m.allocated, backordered: m.backordered,
    leadTimeDays: m.leadTimeDays || 30,
    reviewDays: REVIEW_DAYS, serviceZ: SERVICE_Z,
  });
  const bt = backtest(series, monthOfFirst, 3) ?? { wmape: null, bias: 0 };

  return {
    sku: m.sku, name: m.name, stockCategory: m.stockCategory,
    supplierCode: m.supplierCode, supplierName: m.supplierName, supplierStock: m.supplierStock,
    bucket: f.bucket, method: f.method, adi: f.adi, cv2: f.cv2,
    history: series, historyStart: axis[0].ym,
    forecast: f.forecast, monthlyForecast: f.monthlyForecastAvg, monthlyStd: f.monthlyStd,
    onHand: m.onHand, onOrder: m.onOrder, allocated: m.allocated, backordered: m.backordered,
    position: rep.position, leadTimeDays: m.leadTimeDays, avgCost: m.avgCost,
    reorderPoint: rep.reorderPoint, safetyStock: rep.safetyStock,
    suggestedQty: rep.suggestedQty,
    suggestedValue: Math.round(rep.suggestedQty * (m.avgCost || 0)),
    coverMonths: rep.coverMonths, belowReorder: rep.belowReorder,
    arrowReorderQty: m.arrowReorderQty, arrowMinimumQty: m.arrowMinimumQty,
    wmape: bt.wmape, bias: bt.bias,
  };
});

await redis.set('forecast:all', JSON.stringify(records));
await redis.set('forecast:meta', JSON.stringify({
  generatedAt: new Date().toISOString(),
  horizonMonths: HORIZON, historyMonths: HISTORY_MONTHS,
  serviceLevelPct: 95, locations: ['1-MEL', '2-MEL'],
}));
```

That's the whole integration. The record shape matches `ForecastRecord` in
`app/api/forecast/route.ts` one-to-one.

---

## 6. Known limitations / next steps

- **BOM is not exploded yet.** `BOMMAST`/`BOMTRAN` give parent→child. If you
  build kits/assemblies in-house, a component's *true* demand = its independent
  sales **plus** dependent demand from forecast parent builds. v1 forecasts each
  SKU on its own sales. Phase 2: explode forecast parent demand down the BOM and
  add it to component independent demand before replenishing.
- **PO timing is collapsed into one number.** `ON_ORDER_QTY` tells you *how
  much* is coming, not *when*. Joining open `PORTRAN` lines on `DELIVERY_DATE`
  would let the page project the forward stock curve and catch a reorder that's
  "covered, but not until after the peak."
- **No MOQ / pack-size rounding.** Suggested quantities are raw. If supplier
  minimums or carton multiples live anywhere in Arrow, round to them.
- **Foreign-currency suppliers.** Buy value is at AUD `AVERAGE_COST`. For
  import POs in `FOREIGN_CURR`, an FX line would sharpen the container target.
- **Confirm the two assumptions in the SQL header** (location codes, sales
  trans types) against your actual data before trusting the totals.
- **Accuracy dashboard.** Per-category WMAPE/bias rolled up over time would tell
  you which buckets the methods serve well and where to intervene.
