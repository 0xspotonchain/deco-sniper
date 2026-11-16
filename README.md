# Testnet sniper — Arc / Robinhood / LitVM

Buy/sell sniper bot for deco's multichain burner wallet
(`0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31`) on three EVM testnets.
**Testnets only. Dry-run by default. No live trades without explicit approval.**

## What each chain actually supports

See `research.md` for the full verified findings. Short version:

| Chain | DEX | Trade route | Status |
|---|---|---|---|
| Robinhood Testnet (46630) | Uniswap v4 (de-facto official stack) | UniversalRouter V4_SWAP | ✅ Ready once a DECO pool exists |
| LitVM LiteForge (4441) | Uniswap V2 **fork** (852 pairs) | Router swaps | ✅ Ready once a DECO pool exists |
| Arc Testnet (5042002) | Uniswap v4 PoolManager, **no UniversalRouter** | — | ⚠️ Watching works; live trading BLOCKED until a v4 router is deployed/verified |

No canonical Uniswap V2 or V3 exists on any of the three testnets. No DECO
pool exists yet on any chain (verified 2026-11-16) — the bot watches and
reports "no pool yet" until the pool-creation step lands.

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

# Watch for the DECO pool on all three chains, one cycle, dry-run
NODE_USE_ENV_PROXY=1 node sniper.js --chain all --mode target --once

# Watch for ANY new pair on LitVM for 5 minutes, dry-run
NODE_USE_ENV_PROXY=1 node sniper.js --chain litvm --mode watch --duration-seconds 300

# Target a different token
NODE_USE_ENV_PROXY=1 node sniper.js --chain robinhood --mode target --token 0x...
```

Options: `--chain arc|robinhood|litvm|all`, `--mode target|watch`,
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

- **Hard testnet-only guard**: any chainId outside `{5042002, 46630, 4441}`
  is refused before any signing. The RPC's reported chainId is verified
  against the chain config on every run.
- **No keys in logs**: the seed/private key is never printed, logged, or
  written. Dry-run never reads the keystore at all.
- **Arc v4 trading is blocked in code** until a UniversalRouter address is
  configured — `buildBuyTx`/`buildSellTx` throw a clear error.
- **Approvals**: sells approve the V2 router (LitVM) or Permit2 (v4) for
  exactly the sell amount, only when the current allowance is insufficient.

## What a live test needs (deco's approval required)

1. **DECO pools must exist first** (separate pool-creation step):
   - LitVM: `router.addLiquidityETH` (DECO + zkLTC) — one call, creates the
     pair and seeds it. Needs DECO + a little zkLTC from the burner.
   - Robinhood: initialize the v4 DECO/ETH pool (fee 3000, tickSpacing 60)
     via PositionManager + add liquidity. Needs DECO + test ETH.
   - Arc: initialize the v4 DECO/USDC-view pool + **deploy/verify a swap
     router first** (no UniversalRouter on Arc testnet).
2. **Then a live test run**: e.g. `node sniper.js --chain litvm --mode target
   --live --buy-amount 0.001 --max-hold 300` — one buy of 0.001 zkLTC and a
   time-based sell after 5 min. Expected cost: ~0.001 zkLTC + gas
   (~150k gas per swap). Same shape on Robinhood (0.001 test ETH).
3. **Verify the v4 encoding with a tiny live swap first**: the
   UniversalRouter V4_SWAP calldata is built from the documented action
   encoding and round-trip tested, but it has not executed on-chain yet —
   the first live v4 trade should be a minimal amount.

## Files

- `sniper.js` — main bot (watch → buy → manage → sell)
- `dryrun.js` — test harness (31 checks)
- `config.js` — chains, DEX addresses, trading params, live gate
- `provider.js` — RPC providers (browser UA) + chainId guard
- `keystore.js` — VM keystore decrypt (live mode only, in-memory)
- `dex/v2.js` — Uniswap V2 watcher/quotes/trades (LitVM)
- `dex/v4.js` — Uniswap V4 watcher/quotes/UniversalRouter trades
- `research.md` — DEX research with sources
- `research/probe*.js` — the on-chain probes behind research.md

## Built with

Built with [Muse](https://muse.ai) — deco's AI agent.
