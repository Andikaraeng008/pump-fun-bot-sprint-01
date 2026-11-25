// Pump.fun Bot Sprint: Make Bot And Win — paper trading bot (agent-fun/replay/v2).
//
// Strategy (two legs, five parameters total):
//  1. Completion-chaser: when a curve's real SOL first crosses 55 (migration completes
//     at 85), buy 0.20 SOL. Exit on a 15% take-profit above the fill price, a 20%
//     trailing stop from the peak price, or a 300-slot max hold. A curve that
//     reaches 55 has shown real buying pressure; the run to 85 is worth ~35% in
//     price terms, far above the ~2.6% round-trip cost. The take-profit matters
//     because these curves cliff-crash ~85% in a handful of slots: a trailing stop
//     alone only acts at the next observed batch, by which time the peak is gone.
//  2. Spray: when a fresh curve's real SOL first crosses 2 (coins that reach 2
//     have proved they are alive: on the dev window their median peak after the
//     crossing is +40%), buy 0.01 SOL (the guardrail minimum). Exit on a 15%
//     take-profit, a 15% trailing stop, or after 120 slots. This leg exists to
//     satisfy the >= 20 distinct-mint round-trip guardrail with capped downside;
//     a spray position whose curve later crosses 55 real SOL upgrades to a chaser
//     leg instead of being sold off. Exits accept any fill price: a tight sell
//     slippage rejects the exit exactly when a crash is fastest and the position
//     bleeds to ~0.
// Both legs are long-only, deterministic (no clock, no randomness; every decision
// comes from the hello message, the batch events and the slot number), and respect
// the 5-open-position cap, the 1%-of-real-reserve order cap and the cash on hand.
//
// The bot talks to the harness through the kit's vendor shim (vendor/makefun-bot.ts):
// the hello message carries capital, caps, latency in slots and fees; every batch
// carries that slot's events plus the fills of the orders decided on earlier slots
// (they resolve latency_slots later). Replies are one JSON line per batch with the
// orders for that slot.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// --- parameters (SOL amounts as lamports; trailing stops in basis points) ---
const CHASER_TRIGGER = 55n * LAMPORTS_PER_SOL; // real SOL first crossing
const CHASER_BUY = 200_000_000n; // 0.20 SOL
const CHASER_TRAIL_BPS = 2000n; // 20% trailing stop from peak
const CHASER_MAX_SLOTS = 300; // max hold, in slots
const TAKE_PROFIT_BPS = 1500n; // 15% above entry: bank the first real gain. These
 // curves cliff-crash ~85% in a handful of slots far more often than they grind
 // up, so a trailing stop alone gives the whole peak back before it can act.
const SPRAY_TRIGGER = 2_000_000_000n; // 2 SOL real, first crossing (survivors only)
const SPRAY_BUY = 10_000_000n; // 0.01 SOL (guardrail minimum buy)
const SPRAY_TRAIL_BPS = 1500n; // 15% trailing stop from peak
const SPRAY_MAX_SLOTS = 120; // max hold, in slots
const SPRAY_MAX_COINS = 20; // cap on spray entries (the guardrail minimum)
const SPRAY_MAX_OPEN = 2; // cap on concurrent spray positions
const BUY_SLIPPAGE_BPS = 500; // 5% slippage tolerance on buys
const SELL_SLIPPAGE_BPS = 10000; // exits must execute: accept any fill price.
 // A crashing curve falls more than 10% in two slots, so a tight sell slippage
 // rejects the exit exactly when it matters most and the position bleeds to ~0.
const BPS = 10_000n;

type Mint = string;

// Price as an exact rational (virtual quote reserves / virtual token reserves).
interface Price {
  num: bigint;
  den: bigint;
}

interface Tracked {
  mint: Mint;
  kind: 'chaser' | 'spray';
  entry: Price; // fill price: SOL spent / tokens received
  peak: Price; // highest price seen since entry
  buySlot: number; // slot the buy fill resolved at
}

// Per-mint memory, in first-seen order (deterministic iteration).
const lastReal = new Map<Mint, bigint>(); // real SOL reserves seen last batch
const tracked = new Map<Mint, Tracked>(); // currently held positions we track
const chaserDone = new Set<Mint>(); // mints already chased once (never re-buy)
const sprayDone = new Set<Mint>(); // mints already sprayed once
const buyKind = new Map<string, 'chaser' | 'spray'>(); // client_id -> leg, for fills
let nextId = 1; // deterministic client_id counter (never random, never clock)
let sprayFilled = 0; // spray buys that filled

function priceOf(state: BotState, mint: Mint): Price | null {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves <= 0n) return null;
  return { num: c.virtual_quote_reserves, den: c.virtual_token_reserves };
}

// a <= b as rationals: a.num * b.den <= b.num * a.den
function leq(a: Price, b: Price): boolean {
  return a.num * b.den <= b.num * a.den;
}

// price after a trailing stop of `trailBps` from peak: peak * (10000 - trail) / 10000
function stoppedOut(now: Price, peak: Price, trailBps: bigint): boolean {
  // now <= peak * (10000 - trail) / 10000  <=>  now.num * peak.den * 10000 <= peak.num * now.den * (10000 - trail)
  return now.num * peak.den * BPS <= peak.num * now.den * (BPS - trailBps);
}

// price at or above entry + `tpBps`: now >= entry * (10000 + tp) / 10000
function takeProfitHit(now: Price, entry: Price, tpBps: bigint): boolean {
  return now.num * entry.den * BPS >= entry.num * now.den * (BPS + tpBps);
}

function onBatch(state: BotState, batch: Batch) {
  const orders: OrderInput[] = [];

  // 1. Fold in the fills that resolved since the last batch: record entries, drop exits.
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') {
      const tokens = BigInt(f.token_amount);
      const quote = BigInt(f.quote_lamports);
      if (tokens > 0n) {
        // The leg is known from the client_id we assigned when sending the order;
        // fall back to size (spray is 0.01 SOL, chaser 0.20 SOL) if it is missing.
        const kind = buyKind.get(f.client_id) ?? (quote >= 100_000_000n ? 'chaser' : 'spray');
        buyKind.delete(f.client_id);
        const p: Price = { num: quote, den: tokens };
        tracked.set(f.mint, { mint: f.mint, kind, entry: p, peak: p, buySlot: f.slot });
        if (kind === 'spray') sprayFilled += 1;
      }
    } else {
      tracked.delete(f.mint);
    }
  }
  // Harness closes (_complete/_flatten/_writeoff) arrive as sell fills too, so any
  // position the account no longer holds is dropped here.
  for (const mint of [...tracked.keys()]) {
    if (!state.positions.has(mint)) tracked.delete(mint);
  }

  // 2. Update peaks and decide exits first (exits free position slots for entries).
  // A spray position whose curve crossed 55 real SOL upgrades to a chaser: the
  // coin proved itself, so it gets the chaser's wider stop and longer hold instead
  // of being sold off as a guardrail filler. Never send a second sell for a mint
  // that already has one pending: the first fills (or is rejected) first, and a
  // duplicate only comes back rejected for insufficient tokens.
  const pendingSell = new Set<Mint>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') pendingSell.add(p.order.mint);
  }
  for (const [mint, t] of tracked) {
    const pos = state.positions.get(mint);
    if (!pos || pos.token_amount <= 0n) continue;
    if (t.kind === 'spray') {
      const curve = state.curves.get(mint);
      if (curve && curve.real_quote_reserves >= CHASER_TRIGGER) t.kind = 'chaser';
    }
    const now = priceOf(state, mint);
    if (now && leq(t.peak, now)) t.peak = now;
    const trail = t.kind === 'chaser' ? CHASER_TRAIL_BPS : SPRAY_TRAIL_BPS;
    const maxSlots = t.kind === 'chaser' ? CHASER_MAX_SLOTS : SPRAY_MAX_SLOTS;
    const peak = t.peak;
    const stopHit = now !== null && stoppedOut(now, peak, trail);
    const profitHit = now !== null && takeProfitHit(now, t.entry, TAKE_PROFIT_BPS);
    const stale = state.slot - t.buySlot >= maxSlots;
    if ((stopHit || profitHit || stale) && !pendingSell.has(mint)) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }

  // 3. Entries: only while a position slot is free and cash covers buy + tx fee.
  // freeCashLamports() already nets out pending orders, so only the buys queued
  // in this batch's reply still need deducting (amount + one tx fee each).
  const txFee = state.txFeeLamports();
  const pendingBuy = new Set<Mint>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
  }
  const selling = new Set<Mint>();
  for (const o of orders) if (o.side === 'sell') selling.add(o.mint);
  let sprayOpen = 0;
  for (const t of tracked.values()) if (t.kind === 'spray') sprayOpen += 1;
  let queuedBuys = 0;
  let queuedLamports = 0n;
  let queuedSpray = 0;
  const buyId = (kind: 'chaser' | 'spray'): string => {
    const id = `b${nextId++}`;
    buyKind.set(id, kind);
    return id;
  };

  for (const [mint, curve] of state.curves) {
    if (curve.complete) continue;
    if (state.committedPositionCount() + queuedBuys >= 5) break;
    if (state.positions.has(mint) || pendingBuy.has(mint) || selling.has(mint)) continue;
    const real = curve.real_quote_reserves;
    const prev = lastReal.get(mint) ?? 0n;
    const free = state.freeCashLamports() - queuedLamports - BigInt(queuedBuys) * txFee;

    // Chaser: first observed crossing of 55 real SOL.
    if (!chaserDone.has(mint) && prev < CHASER_TRIGGER && real >= CHASER_TRIGGER) {
      chaserDone.add(mint);
      if (free >= CHASER_BUY + txFee && state.maxBuyLamports(mint) >= CHASER_BUY) {
        orders.push({ side: 'buy', mint, client_id: buyId('chaser'), quote_lamports: CHASER_BUY, max_slippage_bps: BUY_SLIPPAGE_BPS });
        queuedBuys += 1;
        queuedLamports += CHASER_BUY;
      }
      continue;
    }
    // Spray: first observed crossing of 2 real SOL, capped in count and concurrency.
    if (
      !sprayDone.has(mint) &&
      sprayFilled + queuedSpray < SPRAY_MAX_COINS &&
      sprayOpen < SPRAY_MAX_OPEN &&
      prev < SPRAY_TRIGGER &&
      real >= SPRAY_TRIGGER
    ) {
      sprayDone.add(mint);
      if (free >= SPRAY_BUY + txFee && state.maxBuyLamports(mint) >= SPRAY_BUY) {
        orders.push({ side: 'buy', mint, client_id: buyId('spray'), quote_lamports: SPRAY_BUY, max_slippage_bps: BUY_SLIPPAGE_BPS });
        queuedBuys += 1;
        queuedLamports += SPRAY_BUY;
        queuedSpray += 1;
        sprayOpen += 1;
      }
    }
  }

  // 4. Remember this batch's real reserves for next batch's crossing detection.
  for (const [mint, curve] of state.curves) {
    lastReal.set(mint, curve.real_quote_reserves);
  }

  return orders;
}

await runBot({ onBatch });
