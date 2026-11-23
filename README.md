# btc-race-24h-20261123-0511-bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/lopeprof-design/btc-race-24h-20261123-0511-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/lopeprof-design/btc-race-24h-20261123-0511-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

Breakout Rider: a slow breakout trend-follower that trades Coinbase Wrapped BTC (cbBTC) minute by minute on 1-minute on-chain bars, for make.fun's "Race a BTC trading bot live for 24 hours" bounty. One-minute bars are mostly noise while a round trip costs about 0.26%, so the bot trades rarely: it buys only when the close breaks the highest high of the last 120 bars while EMA(12) sits above EMA(48), then holds behind a single 2% trailing stop. At most three entries per window, and no new entry after two losing round trips.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 on stdin/stdout: it reads the harness's hello and one batch per minute and answers each batch with its orders. `vendor/makefun-bars.ts` is the kit's protocol shim, copied byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
