// V-catcher IV — cbBTC 1-minute trading bot for make.fun
// "Race a BTC trading bot live for 24 hours" (btc-race-24h-20261118-1444).
//
// Long-only, full size, one position. Four edge-triggered entry legs
// (a leg fires only on its false -> true transition, so a bot never
// re-buys the same stale signal right after a stop-out), one shared
// exit: a profit target plus a trailing stop from the peak close
// since entry. Every decision is a BigInt comparison on raw closes;
// no floats, no clock, no network, no randomness, no environment.
//
// Entry legs (returns in basis points, closes only):
//   TREND  — 120-bar return >= +50 bps AND 60-bar return >= +50 bps.
//            A sustained recovery: catches slow multi-hour climbs
//            (the dev window's mid-day recovery) instead of chasing
//            one-bar spikes.
//   MR     — 30-bar return <= -60 bps AND 5-bar return >= +20 bps.
//            Mean reversion: a short dip that has already started
//            to bounce.
//   DIP    — 60-bar return <= -150 bps AND 5-bar return >= +50 bps.
//            Deep-dip reversal after a sharp sell-off.
//   BURST  — 5-bar return >= +65 bps. A fast momentum burst.
// Exit (while holding):
//   TARGET — close >= entry price * (1 + 80 bps): bank the leg.
//   TRAIL  — close <= peak close * (1 - 80 bps): give a winner room
//            to breathe, cut it once it turns decisively.
// Entry price is the buy fill's own price, read from the batch's
// fills (both BigInts from the harness), never from a float.
//
// Sizing: a buy spends all cash (100% of equity, the cap). One order
// per reply at most. max_slippage_bps 100: the dev window's largest
// 1-minute close move is 64 bps, so a genuine fill is never blocked
// by the cap, while a violent gap is.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;
const MAX_SLIPPAGE_BPS = 100;

// Entry thresholds, in basis points.
const TREND_120_BPS = 50n;
const TREND_60_BPS = 50n;
const MR_30_BPS = -60n;
const MR_5_BPS = 20n;
const DIP_60_BPS = -150n;
const DIP_5_BPS = 50n;
const BURST_5_BPS = 65n;

// Exit thresholds, in basis points.
const TARGET_BPS = 80n;
const TRAIL_BPS = 80n;

// History kept: decisions look back at most 120 bars.
const HISTORY_MAX = 240;

const closes: bigint[] = [];
let prevTrend = false;
let prevMr = false;
let prevDip = false;
let prevBurst = false;
let holding = false;
let entryPx = 0n;
let peakPx = 0n;

/** Return of the latest close vs the close `w` bars back, in bps. Null when too few bars. */
function retBps(w: number): bigint | null {
  const n = closes.length;
  if (n <= w) return null;
  const now = closes[n - 1];
  const past = closes[n - 1 - w];
  if (past <= 0n) return null;
  return ((now - past) * BPS) / past;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > HISTORY_MAX) closes.splice(0, closes.length - HISTORY_MAX);

    // The exact fill price of a buy that landed on this batch: the
    // entry price for the target / trailing stop. (Deriving it from
    // cost / qty instead overstates it by the 4 bps fee, because the
    // position's cost is the cash spent, fees included — enough to
    // miss a target exit by a few bps, as the dev window's first
    // trade showed.)
    for (const fill of batch.fills) {
      if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
        entryPx = BigInt(fill.price);
        peakPx = entryPx;
        holding = true;
      }
    }

    const pos = state.positions.get(SYMBOL);
    const qty = pos === undefined ? 0n : pos.qty;

    if (qty === 0n) {
      holding = false;
      const r5 = retBps(5);
      const r30 = retBps(30);
      const r60 = retBps(60);
      const r120 = retBps(120);
      const trend =
        r120 !== null && r60 !== null && r120 >= TREND_120_BPS && r60 >= TREND_60_BPS;
      const mr =
        r30 !== null && r5 !== null && r30 <= MR_30_BPS && r5 >= MR_5_BPS;
      const dip =
        r60 !== null && r5 !== null && r60 <= DIP_60_BPS && r5 >= DIP_5_BPS;
      const burst = r5 !== null && r5 >= BURST_5_BPS;
      // Edge trigger: fire only on a fresh false -> true transition.
      // The previous values are the last ones seen while flat, so a
      // signal that stayed true through a whole hold cannot re-fire
      // the moment a stop-out frees the cash.
      const fire =
        (trend && !prevTrend) ||
        (mr && !prevMr) ||
        (dip && !prevDip) ||
        (burst && !prevBurst);
      prevTrend = trend;
      prevMr = mr;
      prevDip = dip;
      prevBurst = burst;
      if (!fire) return [];
      if (state.cash <= 0n) return [];
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }

    // Holding: initialise entry / peak from the filled position.
    // Normally the buy fill above already set them exactly; this
    // fallback derives them from cost / qty (cost is the cash spent,
    // fees included, so it sits ~4 bps above the fill price):
    // value = qty * price * 10^quote_scale / 10^(qty_scale + price_scale),
    // so price = cost * 10^(8 + 5) / (qty * 10^6) = cost * 10^7 / qty.
    if (!holding) {
      holding = true;
      entryPx = (pos!.cost * 10000000n) / qty;
      peakPx = entryPx;
    }
    if (close > peakPx) peakPx = close;
    const trailing = close * BPS <= peakPx * (BPS - TRAIL_BPS);
    const target = close * BPS >= entryPx * (BPS + TARGET_BPS);
    if (!trailing && !target) return [];
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  },
});
