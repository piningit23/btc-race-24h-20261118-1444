# V-catcher IV — cbBTC trading bot

Long-only bot for make.fun's "Race a BTC trading bot live for 24
hours" (`btc-race-24h-20261118-1444`): trades Coinbase Wrapped BTC
(cbBTC) on 1-minute bars with $1,000 paper money.

Strategy: four edge-triggered entry legs (sustained-trend,
mean-reversion dip, deep-dip reversal, momentum burst) with a
+80 bps profit target and an 80 bps trailing stop. All decisions
are BigInt comparisons on raw closes — no floats, clock, network,
or randomness.

Dev-window grade: **net PnL +20.027602 USDC**, 6 trades (3 round
trips, win rate 1.000), max drawdown 0.72%. Beats every kit
baseline (best baseline: hold-cash $0.00).

See `BUILD-NOTES.md` for the full strategy, parameter search, and
rejected rules.
