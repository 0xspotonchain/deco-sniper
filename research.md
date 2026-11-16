# DEX research — Arc / Robinhood / LitVM testnets

Researched 2026-11-16 by on-chain probing (eth_getCode / eth_call / eth_getLogs
against the public RPCs) + official Uniswap docs + third-party sources.
All addresses below were verified live on-chain unless marked otherwise.
**Nothing here is invented**: an address is listed only if code exists at it
on the named testnet, or if it is explicitly labelled as a mainnet-only address.

## TL;DR — canonical Uniswap verdict

| Chain | V2 canonical | V3 canonical | V4 canonical | Usable for DECO pools |
|---|---|---|---|---|
| Arc Testnet (5042002) | No | No | **Partial** — PoolManager live, no UniversalRouter | V4 PM 0x8366… (needs a router for swaps) |
| Robinhood Testnet (46630) | No | No | **Yes (de-facto)** — full stack at mainnet addresses | V4, best chain |
| LitVM LiteForge (4441) | No (community fork only) | No | No (fork PM only, no periphery) | V2 fork (852 pairs) |

**"Canonical" means: published in Uniswap's official docs for that chain.**
Uniswap publishes NO testnet deployment for any of these three chains — the
v4 docs testnet section lists only Unichain Sepolia, Sepolia, Base Sepolia,
Arbitrum Sepolia and the interop alphas. So strictly, none of these testnets
has a docs-listed Uniswap deployment. What they DO have:

- **Robinhood testnet**: the docs-listed Robinhood **mainnet** (4663) v4
  addresses all resolve to live contracts on testnet, and the PoolManager
  bytecode is identical to Arc testnet's. Independent third-party verification
  (HookFence, 2026-09-23) confirms the testnet PoolManager. This is as close
  to "official" as a testnet gets — treat as the de-facto official v4.
- **Arc testnet**: the same v4 PoolManager address is live with identical
  bytecode, but Uniswap's docs list no Arc deployment at all (mainnet or
  testnet), and there is no UniversalRouter on Arc testnet. The PoolManager
  is confirmed by sdk-core `ARC_ADDRESSES` and the UniswapX playbook (both
  Uniswap-owned sources) for Arc **mainnet**; on testnet it exists but is
  undocumented.
- **LitVM**: no Uniswap deployment of any version. Only community forks.

## DECO token (deco's own, deployed 2026-11-16 ~04:12 WIB)

- Address (same on all three chains): `0x5f1dF574015C9D044b4C9Ef658cD55aFcC13D783`
- "Deco Token", DECO, 18 decimals, 1,000,000 fixed supply, all held by the
  burner `0xF1d949ed9B0b62508203AB0B91Bf01E73309Ad31`.
- Verified on-chain 2026-11-16: code exists + burner balance = 1,000,000 DECO
  on all three chains. Full record: `~/workspace/tokens/deployments.md`.
- **No DECO pool exists yet on any chain** (checked 2026-11-16):
  - LitVM V2 `getPair(DECO, WETH)` = `0x0000…0000`.
  - Arc v4 `StateView.getSlot0(DECO/USDC-view poolId)` = sqrtPriceX96 0.
  - RH v4 `StateView.getSlot0(DECO/ETH poolId)` = sqrtPriceX96 0.

## Robinhood Chain Testnet (46630) — best chain

### Verified on-chain (2026-11-16)
| Contract | Address | Evidence |
|---|---|---|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24,009 bytes code; Blockscout-verified "PoolManager"; bytecode keccak `0xbd388118…` identical to Arc testnet's; owner `0x9701fb0ade1e269c8f64ec0c7b3cfadb31a13a52` |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | 23,877 bytes code; "Uniswap v4 Positions NFT" on Blockscout |
| Uniswap v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 6,118 bytes code |
| Uniswap v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3,531 bytes code; `getSlot0` works (see note) |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` | 24,546 bytes code |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 bytes code (canonical cross-chain address) |

All six match the **official Uniswap docs for Robinhood Chain mainnet (4663)**
(v4 deployments page + v3 robinhood-chain page, both in `Uniswap/docs`).
The UniversalRouter address is identical on the v3 and v4 docs pages
(independent cross-check). The docs publish no 46630 testnet row — the
testnet deployment mirrors mainnet addresses but is not docs-listed.

### NOT present on testnet
- **V3**: docs-listed mainnet v3 addresses are all EMPTY on testnet:
  factory `0x1f7d7550…`, SwapRouter02 `0xcaf681a6…`, NFPM `0x73991a25…`,
  QuoterV2 `0x33e885ed…`. (Community v3 forks exist — "Uniswap V3 Positions
  NFT" tokens on Blockscout — but they are not canonical Uniswap.)
- **V2**: canonical factory `0x5C69…` / router `0x7a25…` empty. V2 LP tokens
  on Blockscout are forks.
- **V4 canonical PoolManager** `0x000000000004444c5dc75cB358380D2e3dE08A90`
  (Ethereum-style) is empty — this chain uses the per-chain address above.

### Activity
- 1,389 Swap events on the PoolManager in the last 10,000 blocks (~17 min at
  100 ms/block). HookFence (2026-09-23) counted >10,000 v4 pools on testnet.
- 0 new pools (Initialize events) in the last 30,000 blocks (~50 min) —
  pool creation is quiet right now.

### DECO pool: what it needs
- Pair: **DECO / native ETH** (v4 currency0 = `address(0)` for native ETH).
- Steps: (1) DECO deployed (done). (2) Initialize pool on the PoolManager
  via `PositionManager.initializePool(key, sqrtPriceX96)` with
  `PoolKey { currency0: 0x0, currency1: DECO, fee: 3000, tickSpacing: 60,
  hooks: 0x0 }` — fee 3000/60 is the standard 0.3% tier; launchpads use
  10000/200. `sqrtPriceX96` sets the starting price (encode with the
  18-decimals-both-sides math). (3) Approve DECO to Permit2
  (`approve(Permit2, amount)`), then `PositionManager.modifyLiquidities`
  with a mint-position action to add liquidity; the position is an NFT.
  (4) Verify with `StateView.getSlot0(poolId)` — nonzero sqrtPriceX96 means
  the pool is live. Trade afterwards via the UniversalRouter (V4_SWAP).

## Arc Testnet (5042002) — v4 PM live, no router

### Verified on-chain (2026-11-16)
| Contract | Address | Evidence |
|---|---|---|
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24,009 bytes code; Blockscout-verified "PoolManager"; bytecode keccak `0xbd388118…` — **identical to Robinhood testnet's**; owner `0x9701fb0ade1e269c8f64ec0c7b3cfadb31a13a52` (same as RH testnet) |
| Uniswap v4 PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | 23,877 bytes code — **different bytecode hash than RH testnet's** (different build/constructor args; same address) |
| Uniswap v4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 6,118 bytes code |
| Uniswap v4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3,531 bytes code; `getSlot0` works |
| USDC ERC-20 view | `0x3600000000000000000000000000000000000000` | 1,798 bytes code; 6 decimals — the quote asset launchpads use |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 bytes code |
| v4 PoolManager (Bitquery) | `0x1d70945634f618eefdf9edaadb59b9a183cef929` | 17,025 bytes code; Blockscout-verified "PoolManager" — a second deployment (launchpad-owned) |
| v4 PoolManager (Radian) | `0x24219d0F3611fE4E438850bB7DB165439957dc9f` | 17,151 bytes code — launchpad's own deployment |

### NOT present on testnet
- **UniversalRouter**: BOTH known addresses empty —
  `0x8876789976decbfcbbbe364623c63652db8c0904` (RH-style) and canonical
  `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD`. Community UniversalRouter
  contracts exist at other addresses (Blockscout search finds several) but
  none is the official one. **Swaps on Arc v4 need a router**: either deploy
  a minimal unlock-based swap router, or verify one of the community routers
  before trusting it. The sniper does NOT trade Arc v4 live until a router
  is configured.
- **V3**: sdk-core Arc mainnet v3 addresses all EMPTY on testnet:
  factory `0xf0db7b58379503491d857dB50AC9ece64c653918`, SwapRouter02
  `0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77`, NFPM `0x39654A85…`,
  QuoterV2 `0x7DfD4F31…`. Community v3 forks exist (Biscotti factory
  `0xcD072e113277d1f5460Bf69568f649b26BD01EF9`, TsukiPad factories) — forks,
  not canonical.
- **V2**: Eco-docs Arc mainnet V2 factory `0x89e5DB8B…` EMPTY on testnet.
  Canonical V2 factory/router also empty. V2 LP tokens on Blockscout are forks.

### Arc-specific gotchas (verified in docs + on-chain)
- **No wrapped native token.** Eco docs: on Arc, `SwapRouter02.WETH9()` is a
  stub that reverts — native-value swaps revert. Arc's native coin is USDC
  and it has no canonical wrapped form. Pools must pair against the USDC
  **ERC-20 view** `0x3600…` (6 decimals), not native.
- **PoolManager views revert.** `PoolManager.getSlot0()` / `getLiquidity()`
  revert on direct eth_call even for live pools (verified 2026-11-16).
  Use **StateView** for pool state — `StateView.getSlot0(poolId)` works.
- **Gas is native USDC (18 decimals).** Gas price ~25 gwei observed.
- **Decimals mismatch in pool math**: DECO is 18 decimals, the USDC view is
  6 decimals — sqrtPriceX96 must account for the 10^12 difference.

### Activity
- 400 Swap events on the 0x8366… PoolManager in the last 2,000 blocks
  (~30 min). 0 new pools (Initialize) in the same window on either PM.

### DECO pool: what it needs
- Pair: **DECO / USDC ERC-20 view** `0x3600…` (6 decimals). currency0 =
  `0x3600…` (lower address), currency1 = DECO.
- Steps: same v4 flow as Robinhood (initialize via PositionManager, add
  liquidity via Permit2 + modifyLiquidities), with the decimals-adjusted
  sqrtPriceX96. **Plus**: a swap router must exist before anyone can trade
  the pool — the pool-creation step should also deploy (or verify) a minimal
  v4 swap router on Arc testnet.

## LitVM LiteForge (4441) — V2 fork only

### Verified on-chain (2026-11-16)
| Contract | Address | Evidence |
|---|---|---|
| UniswapV2Factory (fork) | `0x5687FDA3BdE14d38057699c402606ab470EcA873` | Blockscout-verified "UniswapV2Factory"; `allPairsLength()` = **852**; pairs have real reserves (e.g. pair[0] ~177k / ~220k tokens) |
| UniswapV2Router02 (fork) | `0xd28967D75750f477E450Df81C73f34E2713B86B4` | Blockscout-verified; `factory()` returns the 0x5687… factory; `WETH()` returns 0x4fd3… |
| WETH (wrapped native) | `0x4fd3765cde8d1d2be4edbaa03940afc56794c304` | "Wrapped Ether", 18 decimals, 67,336 holders, 2,214 total supply |
| v4 PoolManager (fork) | `0xDF6166bEf93B3aE8BFCe73225Dc5348c5A0Ad96A` | 17,066 bytes code; Blockscout-verified "PoolManager" — but NO periphery (no PositionManager / UniversalRouter / Quoter at any known address) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 bytes code (canonical address; present on every chain, proves nothing about DEX activity) |

Three V2 factories and three V2 routers exist; the 0x5687…/0xd289… pair is
the one with 852 pairs and the router whose `factory()`/`WETH()` match it.
Sample pairs trade test tokens (e.g. mock "BNB" `0x3135…`, 72,733 holders).

### NOT present
- **No canonical Uniswap of any version.** Canonical V2 factory/router,
  V3 factory/router, V4 PoolManager (both canonical and RH/Arc addresses),
  UniversalRouter, PositionManager, Quoter, StateView — all EMPTY.
- The V2 deployment is a **community fork**: same bytecode interface as
  Uniswap V2 (verified `factory()`/`token0()`/`token1()`/`getReserves()`/
  `allPairsLength()` behave per spec), but it is NOT Uniswap's deployment
  and must not be called "Uniswap" without the "fork" qualifier.

### Activity
- 0 new pairs (PairCreated) in the last 3,000 blocks. The 852 pairs are
  historical; creation is quiet right now.

### DECO pool: what it needs
- Pair: **DECO / WETH** `0x4fd3…` (the router's wrapped native).
- Steps: (1) DECO deployed (done). (2) Approve DECO to the router
  (`approve(0xd289…, amount)`). (3) One call creates the pair AND adds
  liquidity: `router.addLiquidityETH(DECO, amountDECO, amountTokenMin,
  amountETHMin, to, deadline)` with `msg.value` in native zkLTC — the
  router wraps zkLTC into WETH and mints LP tokens to `to`. The price is
  set by the ratio of the two amounts added. (4) Verify with
  `factory.getPair(DECO, WETH)` (nonzero) + `pair.getReserves()`.

## What a pool needs — summary for the pool-creation step

| Chain | DEX | Pair asset for DECO | Pool creation | Trade route after |
|---|---|---|---|---|
| Robinhood 46630 | Uniswap v4 (de-facto official) | native ETH (`address(0)`) | PositionManager init + add liquidity | UniversalRouter V4_SWAP |
| Arc 5042002 | Uniswap v4 PM (unofficial, no router) | USDC ERC-20 view `0x3600…` (6 dec) | PositionManager init + add liquidity | **needs a router first** |
| LitVM 4441 | Uniswap V2 fork | WETH `0x4fd3…` (wrapped zkLTC) | `router.addLiquidityETH` (one call) | Router `swapExactETHForTokens` / `swapExactTokensForETH` |

## Sources
- Official Uniswap v4 deployments (Uniswap/docs, main):
  https://github.com/Uniswap/docs/blob/main/content/protocols/v4/deployments.mdx
  — Robinhood Chain: 4663 section (PoolManager 0x8366…, PositionManager
  0x58da…, Quoter 0x8dc1…, StateView 0xf333…, UniversalRouter 0x8876…);
  testnet section has NO Arc/Robinhood/LitVM rows; no Arc section at all.
- Official Uniswap v3 Robinhood deployments (Uniswap/docs, main):
  https://github.com/Uniswap/docs/blob/main/content/protocols/v3/deployments/v3-robinhood-chain-deployments.mdx
  — factory 0x1f7d7550…, SwapRouter02 0xcaf681a6…, NFPM 0x73991a25…,
  QuoterV2 0x33e885ed… (all EMPTY on testnet — verified on-chain).
- UniswapX playbook, Arc chain notes (Uniswap-owned repo):
  https://github.com/uniswap/uniswapx/blob/HEAD/playbook/chains/arc.md
  — v4 PoolManager 0x8366… per sdk-core ARC_ADDRESSES; v3 factory
  0xf0db…3918, SwapRouter02 0x53bf…6f77, v4 Quoter 0x8dc1…8f94.
- Eco docs, Uniswap V3 / Arc chain pages: https://docs.eco.com/sauce-sdk/reference/protocols/uniswap-v3
  and https://docs.eco.com/sauce-sdk/reference/chains/arc — Arc v3/v2
  addresses; "WETH9() on Arc is a stub that reverts; trade USDC's ERC-20
  0x3600…".
- Bitquery Arc testnet docs: https://docs.bitquery.io/docs/blockchain/arc-testnet/
  — v4 PoolManager 0x1d709456… on Arc testnet; DEX breakdown (v4/v3/v2/Curve/
  Aerodrome present as deployments).
- HookFence testnet survey (2026-09-23):
  https://github.com/moo7x/hookfence/blob/HEAD/docs/TESTNET_SURVEY.md
  — Robinhood testnet PoolManager 0x8366… verified live, >10,000 v4 pools.
- robinhood-toolkit deployments (resolved from Uniswap docs, verified on-chain):
  https://github.com/nirholas/robinhood-toolkit/blob/HEAD/dex/DEPLOYMENTS.md
  — "Uniswap publishes no deployment for the Robinhood testnet as of 2026-07-21."
- Windrose chain notes: https://docs.windrose.market/protocol/chain-notes
  — "The testnet has no official deployment, so the launchpad deployed its
  own there" (RH + Arc testnets; 2026-09-18 — partly superseded by the
  on-chain evidence above for the 0x8366… PoolManager).
- Radian launchpad docs: https://radian-sable.vercel.app/api-docs
  — Arc testnet PoolManager 0x24219d0F… (launchpad's own).
- On-chain probes (this repo): `research/probe1.js` … `research/probe5.js`
  — eth_getCode / eth_call / eth_getLogs runs, 2026-11-16.
- DECO deployment record: `~/workspace/tokens/deployments.md`.
