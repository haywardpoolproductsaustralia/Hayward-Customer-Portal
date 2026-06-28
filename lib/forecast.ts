// Forecasting + replenishment engine for the Hayward portal.
//
// Pure functions, no I/O, no dependencies - so the SAME code can run in two
// places: inside portal-sync (Node on AZ-Grey) to pre-compute every SKU at
// sync time, and inside an API route if you ever want on-demand recompute.
// Keeping it dependency-free is deliberate: there is no Python/ML runtime in
// the Vercel stack, and these methods are explainable to a planner, which an
// opaque model is not.
//
// The flow is: monthly demand series -> classify the SKU's demand pattern ->
// route to the right forecast method -> turn the forecast into a concrete
// "order this many, it's worth this much" replenishment recommendation.

export type DemandBucket = 'smooth' | 'erratic' | 'intermittent' | 'lumpy' | 'dead';

export interface Classification {
  adi: number;   // Average inter-Demand Interval (months between sales)
  cv2: number;   // squared coefficient of variation of non-zero demand sizes
  bucket: DemandBucket;
}

// Syntetos-Boylan-Croston classification. ADI says how *often* it sells,
// CV^2 says how *variable* the quantity is when it does. The four quadrants
// each want a different forecasting method - applying one method to all of
// them is the single most common demand-planning mistake.
export function classify(series: number[]): Classification {
  const nz = series.filter((v) => v > 0);
  if (nz.length === 0) return { adi: Infinity, cv2: 0, bucket: 'dead' };

  // intervals between consecutive non-zero months
  const intervals: number[] = [];
  let gap = 0;
  let seen = false;
  for (const v of series) {
    if (v > 0) {
      if (seen) intervals.push(gap);
      seen = true;
      gap = 1;
    } else {
      gap++;
    }
  }
  const adi = intervals.length
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : series.length / nz.length;

  const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
  const variance = nz.reduce((a, b) => a + (b - mean) ** 2, 0) / nz.length;
  const cv2 = mean ? variance / mean ** 2 : 0;

  let bucket: DemandBucket;
  if (adi < 1.32 && cv2 < 0.49) bucket = 'smooth';
  else if (adi < 1.32) bucket = 'erratic';
  else if (cv2 < 0.49) bucket = 'intermittent';
  else bucket = 'lumpy';

  return { adi: round(adi, 2), cv2: round(cv2, 2), bucket };
}

// Monthly seasonal indices (mean-normalised to 1.0). For Hayward this is the
// whole game: pool gear peaks Oct-Mar (southern-hemisphere summer) and a flat
// moving average will badly under-forecast going into spring. We shrink the
// indices toward 1.0 when there is less than ~2 full years of evidence, so a
// SKU with one freak month doesn't get a wild seasonal swing pinned on it.
export function seasonalIndices(series: number[], monthOfFirst: number, period = 12): number[] {
  const sums = Array(period).fill(0);
  const counts = Array(period).fill(0);
  series.forEach((v, i) => {
    const m = (monthOfFirst + i) % period;
    sums[m] += v;
    counts[m]++;
  });
  const overallMean = series.reduce((a, b) => a + b, 0) / series.length || 1;
  const cycles = series.length / period;
  const shrink = Math.min(1, Math.max(0, cycles - 1));

  const idx = Array(period).fill(1);
  for (let m = 0; m < period; m++) {
    if (counts[m] > 0) {
      const raw = sums[m] / counts[m] / overallMean;
      idx[m] = 1 + shrink * (raw - 1);
    }
  }
  const meanIdx = idx.reduce((a, b) => a + b, 0) / period;
  return idx.map((v) => v / meanIdx);
}

// Seasonal baseline: deseasonalise -> read level + a clamped trend off the
// recent deseasonalised run -> re-apply the seasonal shape forward. Plain
// enough to explain in a sentence ("recent run-rate, shaped by your normal
// year") and robust to the zeros that break multiplicative Holt-Winters.
export function forecastSeasonal(series: number[], monthOfFirst: number, horizon: number): number[] {
  const period = 12;
  const idx = seasonalIndices(series, monthOfFirst, period);
  const deseason = series.map((v, i) => v / (idx[(monthOfFirst + i) % period] || 1));

  const last3 = deseason.slice(-3);
  const level = last3.reduce((a, b) => a + b, 0) / last3.length;

  let trend = 0;
  const w = deseason.slice(-6);
  if (w.length >= 4) {
    const xm = (w.length - 1) / 2;
    const ym = w.reduce((a, b) => a + b, 0) / w.length;
    let num = 0;
    let den = 0;
    w.forEach((y, x) => {
      num += (x - xm) * (y - ym);
      den += (x - xm) ** 2;
    });
    trend = den ? num / den : 0;
    const cap = 0.05 * level; // never project more than +/-5%/month of drift
    trend = Math.max(-cap, Math.min(cap, trend));
  }

  const out: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const m = (monthOfFirst + series.length - 1 + h) % period;
    out.push(Math.max(0, (level + trend * h) * (idx[m] || 1)));
  }
  return out;
}

// Croston / SBA for intermittent + lumpy demand. Forecasts demand *size* and
// the *interval* between demands separately, then a per-period rate = size /
// interval. SBA applies the (1 - alpha/2) de-bias correction Croston is known
// to need. A normal moving average over mostly-zero months is hopeless here.
export function forecastCroston(
  series: number[],
  horizon: number,
  alpha = 0.1,
  sba = true
): number[] {
  let z: number | null = null; // smoothed demand size
  let p: number | null = null; // smoothed interval
  let q = 1; // periods since last demand
  for (const v of series) {
    if (v > 0) {
      z = z == null ? v : z + alpha * (v - z);
      p = p == null ? q : p + alpha * (q - p);
      q = 1;
    } else {
      q++;
    }
  }
  if (z == null) return Array(horizon).fill(0);
  let rate = z / (p || 1);
  if (sba) rate *= 1 - alpha / 2;
  return Array(horizon).fill(Math.max(0, rate));
}

export interface ForecastResult extends Classification {
  method: 'Seasonal' | 'SBA/Croston' | 'None';
  forecast: number[];          // per-month, length = horizon
  monthlyForecastAvg: number;  // mean of the horizon - the headline rate
  monthlyStd: number;          // std of recent demand, feeds safety stock
}

// Route each SKU to the method its demand pattern actually calls for.
export function buildForecast(series: number[], monthOfFirst: number, horizon: number): ForecastResult {
  const cls = classify(series);
  let method: ForecastResult['method'];
  let forecast: number[];

  if (cls.bucket === 'dead') {
    method = 'None';
    forecast = Array(horizon).fill(0);
  } else if (cls.bucket === 'intermittent' || cls.bucket === 'lumpy') {
    method = 'SBA/Croston';
    forecast = forecastCroston(series, horizon);
  } else {
    method = 'Seasonal';
    forecast = forecastSeasonal(series, monthOfFirst, horizon);
  }

  const monthlyForecastAvg = forecast.reduce((a, b) => a + b, 0) / (forecast.length || 1);
  const recent = series.slice(-12);
  const rMean = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
  const monthlyStd = Math.sqrt(
    recent.reduce((a, b) => a + (b - rMean) ** 2, 0) / (recent.length || 1)
  );

  return {
    ...cls,
    method,
    forecast: forecast.map((v) => round(v, 1)),
    monthlyForecastAvg: round(monthlyForecastAvg, 1),
    monthlyStd: round(monthlyStd, 1),
  };
}

export interface ReplenishmentInput {
  monthlyForecast: number;
  monthlyStd: number;
  onHand: number;
  onOrder: number;
  allocated: number;
  backordered: number;
  leadTimeDays: number;
  reviewDays?: number;   // how often you actually place orders (default fortnightly)
  serviceZ?: number;     // 1.65 ~ 95% cycle service level
  coverMonths?: number;  // how much buffer beyond ROP to order up to
}

export interface ReplenishmentResult {
  position: number;        // inventory position = on hand + on order - allocated - backorder
  safetyStock: number;
  reorderPoint: number;
  suggestedQty: number;    // 0 means no action needed
  coverMonths: number;     // months of forward cover the current position gives
  belowReorder: boolean;
}

// Turn a demand rate into a buy decision. demandOverLeadTime + safety stock
// gives the reorder point; if the inventory position has dropped below it,
// order back up to (ROP + a few months' cover). Safety stock scales with both
// demand variability and the square root of the lead-time window - the longer
// and lumpier the resupply, the more buffer it takes to hold a service level.
export function replenishment(input: ReplenishmentInput): ReplenishmentResult {
  const {
    monthlyForecast,
    monthlyStd,
    onHand,
    onOrder,
    allocated,
    backordered,
    leadTimeDays,
    reviewDays = 14,
    serviceZ = 1.65,
    coverMonths = 2,
  } = input;

  const ltMonths = Math.max(0.1, (leadTimeDays + reviewDays) / 30);
  const demandOverLeadTime = monthlyForecast * ltMonths;
  const safetyStock = serviceZ * monthlyStd * Math.sqrt(ltMonths);
  const reorderPoint = demandOverLeadTime + safetyStock;

  const position = onHand + onOrder - allocated - backordered;
  const orderUpTo = reorderPoint + monthlyForecast * coverMonths;
  const suggestedQty = position < reorderPoint ? Math.max(0, Math.ceil(orderUpTo - position)) : 0;
  const coverMonths_ = monthlyForecast > 0 ? position / monthlyForecast : Infinity;

  return {
    position: round(position, 0),
    safetyStock: round(safetyStock, 0),
    reorderPoint: round(reorderPoint, 0),
    suggestedQty,
    coverMonths: Number.isFinite(coverMonths_) ? round(coverMonths_, 1) : 999,
    belowReorder: position < reorderPoint,
  };
}

export interface BacktestResult {
  wmape: number | null; // weighted MAPE %, lower is better
  bias: number;         // total signed error over the holdout; + = over-forecast
}

// Hold out the last `holdout` months, forecast them from the rest, and report
// accuracy. Bias matters more than WMAPE for inventory: a method that's 20%
// off but unbiased self-corrects on average; one that's consistently low
// quietly bleeds you into stockouts.
export function backtest(series: number[], monthOfFirst: number, holdout = 3): BacktestResult | null {
  if (series.length < holdout + 12) return null;
  const train = series.slice(0, -holdout);
  const actual = series.slice(-holdout);
  const { forecast } = buildForecast(train, monthOfFirst, holdout);

  let absErr = 0;
  let sumA = 0;
  let bias = 0;
  actual.forEach((a, i) => {
    absErr += Math.abs(a - forecast[i]);
    sumA += a;
    bias += forecast[i] - a;
  });
  return {
    wmape: sumA ? round((absErr / sumA) * 100, 1) : null,
    bias: round(bias, 1),
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
