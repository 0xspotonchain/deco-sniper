# Testnet sniper — Arc / Robinhood / LitVM / Velana

Buy/sell sniper bot for deco's multichain burner wallet
(`0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31`) on four EVM testnets.
**Testnets only. Dry-run by default. No live trades without explicit approval.**

## What each chain actually supports

See `research.md` for the full verified findings. Short version:

| Chain | DEX | Trade route | Status |
|---|---|---|---|
| Robinhood Testnet (46630) | Uniswap v4 (de-facto official stack) | UniversalRouter V4_SWAP | ✅ Live — real v4 DECO/ETH pool, traded 2 cycles |
| LitVM LiteForge (4441) | Uniswap V2 **fork** (852 pairs) | Router swaps | ✅ Ready once a DECO pair exists |
| Arc Testnet (5042002) | Uniswap v4 PoolManager, **no UniversalRouter** | — | ⚠️ Watching works; live trading BLOCKED until a v4 router is deployed/verified |
| Velana Testnet (484148) | Own SimpleAMM pool (no Uniswap) | `volume.js` rounds | ✅ Live — 1,000/1,000 first run |

No canonical Uniswap V2 or V3 exists on any of the four testnets. DECO
pools exist on all four chains now: own SimpleAMM pools (see the
deco-tokens repo) plus a real Uniswap v4 DECO/ETH pool on Robinhood. The
volume sniper trades the SimpleAMM pools daily; the position-mode sniper
has traded the v4 pool live (see below).

## Install

```bash
cd ~/workspace/sniper
npm install   # ethers v6 only
```

Node 20+ required. On this VM, Node needs the proxy env var for network
access: prefix commands with `NODE_USE_ENV_PROXY=1`.

## Run

```bash
# Dry-run test harness (31 checks, no broadcasts, no keystore access)
NODE_USE_ENV_PROXY=1 node dryrun.js

# Watch for the DECO pool on all four chains, one cycle, dry-run
NODE_USE_ENV_PROXY=1 node sniper.js --chain all --mode target --once

# Watch for ANY new pair on LitVM for 5 minutes, dry-run
NODE_USE_ENV_PROXY=1 node sniper.js --chain litvm --mode watch --duration-seconds 300

# Target a different token
NODE_USE_ENV_PROXY=1 node sniper.js --chain robinhood --mode target --token 0x...
```

Options: `--chain arc|robinhood|litvm|velana|all`, `--mode target|watch`,
`--token 0x…`, `--once`, `--auto-buy` (watch mode), `--duration-seconds`,
`--buy-amount`, `--tp`, `--sl`, `--max-hold`, `--slippage-bps`,
`--poll-seconds`. See `node sniper.js --help`.

## How it works

- **Pair watcher**: polls the V2 factory's `allPairsLength()` (LitVM) or the
  v4 PoolManager's `Initialize` logs (Arc/Robinhood). Public RPCs expose no
  mempool, so polling is the realistic approach — expect seconds of latency,
  not milliseconds. Poll interval default 10s.
- **Target mode**: watches one token (default DECO) until its pool appears,
  buys once, then manages the position.
- **Exits**: take-profit (default +100%), stop-loss (default −50%),
  time-based (default 1h). Prices come from V2 reserves or v4
  `StateView.getSlot0` (PoolManager views revert on these chains — verified).
- **Spend caps**: per-trade 0.005 native / 5 USDC (Arc), per-run 0.02 native
  / 20 USDC (Arc), max 3 concurrent positions. Caps are in `config.js`.
- **Target mode re-enters**: after a position closes, the next cycle buys
  again if the pool is still there — this is the spam buy/sell loop, bounded
  by the per-run spend cap.

## Volume mode (`volume.js`)

Buy-then-sell-back rounds against deco's OWN SimpleAMM pools (see the
deco-tokens repo) — the volume test, modeled on our friend
[0xzunid](https://0xzunid.github.io/0xzunid.muse.ai/)'s approach. One round =
1 buy + 1 sell (2 txs). Round size: 0.1 USDC on Arc, 0.0001 ETH on
Robinhood, 0.0001 zkLTC on LitVM, 0.0001 VELA on Velana.

First run (2026-11-16): 1,000 rounds/chain on all four chains — 8,007
txs total, all verified on-chain. Daily totals + first/last tx links in
`VOLUMES.md`; per-chain summaries in `volume-summaries/`; full per-tx
logs in `volume-logs/`; the full incident + fix record (including a
cleanup bug that dumped 990,000 DECO and the buy-back that restored it)
in `volume-proof-2026-11-16.md`.

Circle wallet run (2026-11-16): the same volume discipline against the
Circle wallet's own DM/USDC pool on Arc — but the Circle wallet is a
smart-contract account, so every write goes through `circle wallet
execute` (bundler userOp) instead of a keystore signature.
`volume-circle.js`: 100/100 rounds, 201 txs on-chain, net +0.038073 USDC
(one round double-sold when the CLI reported a landed sell as failed —
both sells verified via Swap events; the runner now re-checks on-chain
state before any retry). Log: `volume-logs/2026-11-16-circle-dm.jsonl`.
Grand total with the burner runs: 4,100 rounds, 8,208 txs.

Daily schedule: 100 rounds/chain/day from Tue 2026-11-17, ~11:11 GMT+7,
chains sequential, Arc gas pre-check (skip Arc if gas > 100 gwei) —
800 txs/day across 4 chains.

```
node volume.js --chain=arc --rounds=100 --live        # live (needs --live)
node volume.js --chain=robinhood --rounds=5           # dry-run (default)
```

## Uniswap v4 pool (Robinhood) — live position trades

A real Uniswap v4 DECO/ETH pool on Robinhood Testnet — pool ID
`0x0c6d73c11e075cd18082b5aae55828c76a3d2b31f2f3e06558d75bd58d0363f7`
(fee 3000, tickSpacing 60, full-range), seeded 0.0021 ETH + 70,000 DECO.
The position-mode sniper (`sniper.js`) traded it live: 2 full buy→sell
cycles, 4 txs confirmed. Details in `robinhood-pool-results.json` and
`v4-logs/`.

Two v4 gotchas on Robinhood testnet, both fixed in `dex/v4.js`:
- The docs-listed Quoter address is NOT a Quoter contract — the sniper uses
  a manual StateView-based quote (`quoteExactInputSingleManual`).
- The UniversalRouter reverts on empty hookData — swaps encode `0x00`.

`create-robinhood-pool.js` creates + seeds the pool; `sell-deco.js` sells an
exact DECO amount (dry-run default); `check-state.js` prints pool + burner
state; `verify-v4-approvals.js` checks the Permit2 approvals.

## Dry-run vs live

**Dry-run (default)** — the bot logs exactly what it WOULD send
(`to`, `data`, `value`, gas estimate) and never broadcasts, never touches
the keystore, never signs. A dry-run sell's gas estimate will fail with
`TRANSFER_FROM_FAILED` when the simulated buy never filled — that is
expected: the bot honestly reports the tx would revert in that state. In
live mode the buy fills first, so the sell can execute.

**Live mode needs TWO steps**:
1. Set `LIVE.enabled = true` in `config.js`, AND
2. Pass `--live` on the command line.

Either one alone keeps the bot in dry-run. Live mode decrypts the burner
key from the VM keystore (in memory only, never logged) and broadcasts real
testnet transactions. Only do this with deco's explicit approval for the run.

## Safety

- **Hard testnet-only guard**: any chainId outside `{5042002, 46630, 4441,
  484148}` is refused before any signing. The RPC's reported chainId is verified
  against the chain config on every run.
- **No keys in logs**: the seed/private key is never printed, logged, or
  written. Dry-run never reads the keystore at all.
- **Arc v4 trading is blocked in code** until a UniversalRouter address is
  configured — `buildBuyTx`/`buildSellTx` throw a clear error.
- **Approvals**: sells approve the V2 router (LitVM) or Permit2 (v4) for
  exactly the sell amount, only when the current allowance is insufficient.

## What a live test needs (deco's approval required)

1. **Pools** — the Robinhood v4 DECO/ETH pool already exists (see above);
   the LitVM V2 pair and the Arc router are still open:
   - LitVM: `router.addLiquidityETH` (DECO + zkLTC) — one call, creates the
     pair and seeds it. Needs DECO + a little zkLTC from the burner.
   - Robinhood: v4 pool live since Nov 16, 18:28 GMT+7 (fee 3000,
     tickSpacing 60) — done, see above.
   - Arc: initialize the v4 DECO/USDC-view pool + **deploy/verify a swap
     router first** (no UniversalRouter on Arc testnet).
2. **Then a live test run**: e.g. `node sniper.js --chain litvm --mode target
   --live --buy-amount 0.001 --max-hold 300` — one buy of 0.001 zkLTC and a
   time-based sell after 5 min. Expected cost: ~0.001 zkLTC + gas
   (~150k gas per swap). Same shape on Robinhood (0.001 test ETH).
3. **Verify the v4 encoding with a tiny live swap first** — done: the
   position-mode sniper has traded the Robinhood v4 pool live (2 full
   buy→sell cycles, 4 txs confirmed). The UniversalRouter V4_SWAP
   encoding is proven; keep new live tests small anyway.

## Files

- `sniper.js` — main bot (watch → buy → manage → sell)
- `dryrun.js` — test harness (31 checks)
- `volume.js` — volume mode: buy-then-sell-back rounds vs the own
  SimpleAMM pools (Arc, Robinhood, LitVM, Velana)
- `config.js` — chains, DEX addresses, trading params, live gate
- `provider.js` — RPC providers (browser UA) + chainId guard
- `keystore.js` — VM keystore decrypt (live mode only, in-memory)
- `amm-addresses.json` — SimpleAMM pool addresses per chain
- `VOLUMES.md` — daily volume totals + first/last tx links
- `volume-summaries/` — per-chain run summaries (JSON)
- `volume-logs/` — full per-tx logs (jsonl, one line per tx)
- `dex/v2.js` — Uniswap V2 watcher/quotes/trades (LitVM)
- `dex/v4.js` — Uniswap V4 watcher/quotes/UniversalRouter trades
- `research.md` — DEX research with sources
- `research/probe*.js` — the on-chain probes behind research.md

## Credits

Pools, name service and volume mode are modeled on our friend [0xzunid](https://github.com/0xzunid)'s approach ([0xzunid.muse](https://0xzunid.github.io/0xzunid.muse.ai/)) — credit where it's due.

## Built with

Built with [Muse](https://muse.ai) — deco's AI agent.
