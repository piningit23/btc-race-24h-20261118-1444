# V-catcher IV — BUILD NOTES

Bot for make.fun "Race a BTC trading bot live for 24 hours"
(`btc-race-24h-20261118-1444`). Long-only cbBTC (CBBTC) on 1-minute
bars, $1,000 paper, full size, one position.

## Strategy

Four **edge-triggered** entry legs — a leg fires only on its
false → true transition while flat, so a signal that stayed true
through a whole hold can never re-buy the moment a stop-out frees
the cash. All decisions are BigInt comparisons on raw closes; no
floats, no clock, no network, no randomness, no environment.

| Leg | Condition (bps, closes only) | Idea |
|---|---|---|
| TREND | 120-bar ret ≥ +50 AND 60-bar ret ≥ +50 | Sustained recovery; catches slow multi-hour climbs, not one-bar spikes |
| MR | 30-bar ret ≤ −60 AND 5-bar ret ≥ +20 | Mean reversion: a short dip that has already started to bounce |
| DIP | 60-bar ret ≤ −150 AND 5-bar ret ≥ +50 | Deep-dip reversal after a sharp sell-off |
| BURST | 5-bar ret ≥ +65 | Fast momentum burst |

Shared exit while holding: **profit target** close ≥ entry ×
(1 + 80 bps), or **trailing stop** close ≤ peak close × (1 − 80 bps).
Entry price is the buy fill's own price, read from the batch's
fills. Sizing: a buy spends all cash. max_slippage_bps 100 (the dev
window's largest 1-minute close move is 64 bps, so a genuine fill
is never blocked by the cap).

History kept: last 240 closes (decisions look back at most 120).

## Dev-window trades (final bot)

| # | Leg | Buy decided → filled | Sell decided → filled | Return |
|---|---|---|---|---|
| 1 | MR | bar 72 → 73 (~$63,870) | bar 85 → 86 (~$64,274) | +0.63% |
| 2 | TREND | bar 191 → 192 (~$63,912) | bar 406 → 407 (~$64,454) | +0.85% |
| 3 | TREND | bar 443 → 444 (~$64,457) | bar 505 → 506 (~$64,943) | +0.75% |

All three round trips won. The dev window itself is a falling day
($65,083 → $63,261, −2.79%): buy-and-hold loses −$31.63.

## Grade-local results (final commit, `--driver process`)

- **Net PnL +20.027602 USDC** (return +0.020027602)
- Trades 6 (3 round trips), win rate 1.000, max drawdown 0.007159162
  (0.72%), exposure 0.201388888, Sharpe 0.040488507, 0 rejected
- Fees 2.423478 USDC; **net PnL at 2× fees +17.589812 USDC**
- Guardrails met (≥1 trade, max DD ≤ 25%)
- L1 regrade reproduced byte for byte; grade run twice on the final
  commit with identical scores
  - action_log_sha256
    `81fb67e72eb4951517f6a89fb76f655cf85bf67a451878d8c1f4f57b79cfe75f`
  - result_sha256
    `cff2f25a5c0d74ba7a7d60ef76ce13771de37812efc6255b7f3058b64bd13153`
    (local node v24.22.1 vs server v26.13.1, so the server's sha will
    differ either way)

### Baselines (same command, same dev window)

| Baseline | Net PnL |
|---|---|
| buy-and-hold | −31.633698 |
| momentum | −23.865251 |
| hold-cash | 0.000000 (guardrails NOT met: 0 trades) |
| rsi-bollinger | −39.916751 |
| adx-momentum | −75.566624 |
| ema-cross | −148.174061 |

The bot (+20.027602) beats every baseline.

## Parameter search (offline simulator first, then grade-local)

An offline Python simulator (latency 1 bar, fee 4 bps, slip 2 bps,
constant-product impact vs depth) was used to search, and every
candidate below was confirmed or rejected on the real grader where
it mattered. Rejected rules and why:

- **Trend with 50 bps trailing stop: REJECTED.** Trend-only,
  trail 50 → −$14.35 (sim). A 50 bps trail whipsaws on 1-minute
  noise (1-minute return sd 6.7 bps, but closes dip often).
- **Reversal exit (sell when 15-min ret ≤ −40 bps): REJECTED.**
  −$13.34 (edge) / −$9.60 (level) in sim — exits winners on noise.
- **SMA-20 deviation (buy close < SMA20 by 30–80 bps): REJECTED.**
  Best −$2.99, worst −$12.58 in sim; buys into a falling knife on
  this window.
- **Donchian breakout (90-bar high + margin): REJECTED as a leg.**
  Fires 0 times on this dev window (0 trades standalone); the trend
  leg already covers sustained uptrends, so it adds race-day
  variance for no dev evidence.
- **Fixed profit target, tested:** target 80 bps is the peak
  (+$20.06 sim) but the whole 64–96 bps band stays positive
  (+$5.04 … +$13.69); no target still gives +$7.02. Kept at 80 bps.
- **Cooldown after exit (30 bars): REPLACED by edge triggering.**
  Level-triggered + 30-bar cooldown gave +$19.42; edge-triggered
  with no cooldown gives +$20.06 and is principled (a fresh cross
  is required), not a tuned waiting period.
- **Trend thresholds:** t60 = 50 bps is a plateau — (40,50),
  (50,50), (60,50) all give +$20.06; (x,60) gives +$2.41, (x,40)
  gives +$8.06, only (40,40) is slightly negative (−$0.33).
- **Trail ±20% (64–96 bps): identical +$20.06** — the target exits
  dominate and the trail is a safety net, not a tuned knob.
- **MR thresholds ±20%: identical +$20.06** (single MR trade,
  insensitive to the exact thresholds).
- **Dip (60m ≤ −150, 5m ≥ +50) and burst (5m ≥ +65) legs:** fire
  0 times on this dev window, so they cost nothing here; kept for
  race-day regime coverage — the same two legs carried the wins on
  the 15 Nov window (dip-reversal + burst, dev +$35.71) and the
  17 Nov window (burst 65 bps, dev +$6.31).

## The entry-price bug (found by grading, fixed)

First graded version derived the entry price from position
cost / qty. That overstates the fill price by the 4 bps fee (the
position's cost is the cash spent, fees included) and missed the
first trade's target exit by ~2 bps: dev PnL was +$11.81 with the
MR trade exiting late on the trailing stop instead of the target.
Fix: read the buy fill's own `price` from the batch's fills.
Dev PnL after the fix: **+$20.03**, win rate 1.000 (was 0.667).

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript)
- `vendor/makefun-bars.ts` — kit SDK shim, byte-identical copy
  (sha256 `9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`)
- `LICENSE` — MIT (from `makefun init`)
- `BUILD-NOTES.md` — this file

## Honest caveats

1. The dev score is carried by 3 round trips on one 24-hour window.
   The race window is unseen; a flat race day may produce few or
   no entry signals (the MR/dip/burst legs are the guardrail cover
   for that, but none of them is guaranteed to fire).
2. The +80 bps target is the peak of its band; the band is positive
   throughout (64–96 bps), but the exact peak is still one window's
   evidence.
3. All three dev trades are trend/MR legs; the dip and burst legs
   are unproven on this window and are kept on cross-window
   evidence from the 15 Nov and 17 Nov races, not on this window.
