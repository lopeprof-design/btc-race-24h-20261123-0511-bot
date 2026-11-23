// Breakout Rider: a slow breakout trend-follower for cbBTC on 1-minute bars.
//
// Idea, in one paragraph: one-minute bars are mostly noise — the dev window's
// closes move about 0.08% a minute, while a full round trip costs about 0.26%
// in fees, slippage and price impact. Any rule that trades the chop therefore
// bleeds out, and the backtests in the build session confirmed it: an EMA
// crossover bot lost money on 76 trades, and every Donchian variant that
// exited on a low-break or an EMA cross lost money too. So this bot trades
// rarely and only on a move that has already proved itself: it buys when the
// close breaks the highest high of the last 120 bars while the fast trend
// sits above the slow one, and then it does nothing but watch a wide trailing
// stop. The stop is the only exit. A 2% pullback from the best close since
// entry ends the trade; anything smaller is treated as noise. Two extra caps
// bound the damage on a window that keeps faking breakouts: at most three
// entries per window, and no new entry after two losing round trips.
//
//   - Indicators, per symbol, over its own closes: EMA(12) and EMA(48), each
//     starting as the mean of its first span of closes, then moving
//     2 / (span + 1) of the way to each new close; and the highest high of
//     the last 120 bars before the current one. A gap (a minute with no bar)
//     adds nothing to any of them. They read every batch, a warm-up's
//     included; while warming up the bot sends no order.
//   - Entry, on a bar's close (filled at the next open): the close breaks
//     above the 120-bar high and EMA(12) is above EMA(48), on a symbol it
//     does not hold, while the entry caps still allow it. The buy spends
//     all the cash it can: the smaller of the cash on hand and the weight
//     room, never below the minimum notional.
//   - Exit, the whole position: the close falls 2% or more below the
//     highest close seen since the entry was decided. The peak is the
//     decision bar's close to start with, then the highest close of every
//     bar after it. No other exit exists on purpose: the chop exits were
//     what lost money in testing.
//   - A round trip counts as losing when the equity at the exit decision is
//     below the equity at the entry decision. After two of those, or three
//     entries in all, the bot stays flat for the rest of the window. After
//     any exit it also waits 60 bars before it may enter again, so it never
//     re-buys the same wiggle it just sold.
//   - Orders cap their slippage at 100 bps (1%) past the close they were
//     decided on, so a buy into a gap or a sell into one is refused rather
//     than filled for almost nothing; a refused sell is sent again on the
//     next bar while the stop still holds, because the peak only ever
//     rises while the position is held.
//   - The math runs in float64 on + - * / alone, each correctly rounded
//     (IEEE 754), so the same bars give the same orders, run after run.
//     Nothing here reads the wall clock, the network, the environment or
//     any file: the bars are the only input, and the seed is unused.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Bars of history a breakout must clear. */
const BREAKOUT_BARS = 120;
/** Fast and slow trend spans, in bars. */
const FAST_SPAN = 12;
const SLOW_SPAN = 48;
/** Trailing stop: sell when the close is this far below the peak close since entry. */
const TRAIL = 0.02;
/** Entries allowed per window, and losing round trips allowed before stopping. */
const MAX_ENTRIES = 3;
const MAX_LOSERS = 2;
/** Bars to wait after an exit before a new entry. */
const COOLDOWN_BARS = 60;
/** Slippage cap on every order, in bps past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** Highest highs of the bars before the current one, at most BREAKOUT_BARS of them. */
  high: number[];
  /** Highest high of the bars before the current one, or null until BREAKOUT_BARS seen. */
  breakoutHigh: number | null;
  /** Highest close since the current entry was decided, or null while flat. */
  peak: number | null;
  /** True once the entry's fill has shown up in the account. */
  inPosition: boolean;
  /** Equity when the current entry was decided, for the losing-trip count. */
  entryEquity: bigint;
  /** Bars since the last exit; counts up while flat. */
  sinceExit: number;
}

const series = new Map<string, Series>();
let entries = 0;
let losers = 0;

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_SPAN, warm: [], value: null },
      slow: { span: SLOW_SPAN, warm: [], value: null },
      high: [],
      breakoutHigh: null,
      peak: null,
      inPosition: false,
      entryEquity: 0n,
      sinceExit: COOLDOWN_BARS,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  const h = Number(bar.h);
  step(s.fast, c);
  step(s.slow, c);
  // The breakout level is the highest high of the bars *before* this one:
  // this bar's own high can never be below its close, so it must not count.
  s.breakoutHigh = s.high.length >= BREAKOUT_BARS
    ? s.high.reduce((a, x) => (x > a ? x : a), -Infinity)
    : null;
  s.high.push(h);
  if (s.high.length > BREAKOUT_BARS) s.high.shift();
  if (s.peak !== null && c > s.peak) s.peak = c;
  return s;
}

await runBars({
  onBatch(state: BarsState, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const orders: (SellInput | BuyInput)[] = [];

    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      const close = state.close(symbol);
      if (close === null) continue;

      if (held !== undefined) {
        // Holding: the trailing stop is the only exit. The peak and the
        // counters stay put until the sell actually fills: a sell the
        // market refuses is sent again on the next bar while the stop holds.
        s.inPosition = true;
        if (s.peak !== null && Number(close) < s.peak * (1 - TRAIL)) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      // Flat. If a position was held on the last bar, the exit has filled:
      // score the round trip, clear the peak and start the cooldown.
      if (s.inPosition) {
        if (state.equity < s.entryEquity) losers += 1;
        s.peak = null;
        s.inPosition = false;
        s.sinceExit = 0;
        continue;
      }

      // Genuinely flat: count the cooldown, then look for a breakout with the trend.
      s.sinceExit += 1;
      if (entries >= MAX_ENTRIES || losers >= MAX_LOSERS) continue;
      if (s.sinceExit < COOLDOWN_BARS) continue;
      if (s.breakoutHigh === null) continue;
      if (s.fast.value === null || s.slow.value === null) continue;
      if (s.fast.value <= s.slow.value) continue;
      if (Number(close) <= s.breakoutHigh) continue;

      let slice = state.cash;
      const room = state.weightRoom(symbol);
      if (room < slice) slice = room;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      entries += 1;
      s.peak = Number(close);
      s.entryEquity = state.equity;
      if (orders.length >= caps.max_orders_per_bar) break;
    }
    return orders;
  },
});
