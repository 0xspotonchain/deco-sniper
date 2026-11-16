# Volume sniper — proof runs + bug fixes, 2026-11-16

## Proof run 1 (buggy code) — NO-GO, incident + recovery
- Robinhood sell-back (906.610893880149131581 DECO) restored seed reserves:
  approve `0xbe23692f8baad505530a1656094bc7068ea95d798e8bbe0a569d380d0a2184f9`,
  sell `0x4d33e9f78f3616f6a7cde387a0498a92ebcb78fa7d83cf153881f895d354a0e1`.
  Reserves back to 10,000 DECO / 0.001000544933154048 ETH.
- Arc live proof 5/5 rounds clean (~10.8s/round, 0.00425 USDC/round gas,
  0.594% round-trip loss), first proof tx (approve DECO)
  `0x5521b551a8b8de1e8677863f963ff19f099ad9d9a33a5d18e9cf378d0cff1cb3`,
  first round buy `0x1996c027f33cb50a05258dbb9f35ff578660089c3276a2983119b35105f8c027`.
- **BUG 1 (critical):** `cleanupSell()` sold the burner's TOTAL DECO balance
  as "leftover". On Arc it dumped 990,000 DECO for 9.90127 USDC
  (`0x62c23a75046716f6bf57c6cdbdcda0057e1176e4b9a1033c92259a9af0a702c3`),
  leaving the pool at 1,000,000 DECO / 0.100334 USDC and the burner with 0 DECO.
  Pool RESTORED by buy-back `0x4f2f26bd86203ebf970e23fac8b5b84e60c8211ff08b89b8fe96b8e422bb0098`
  (spent 9.962955 USDC, received 990,000.000134550599182298 DECO).
  Net cost of the incident ≈ 0.091 USDC. Reserves after: 9,999.999865449400817702
  DECO / 10.063289 USDC. Robinhood/LitVM live proofs were NOT run (bug would
  have drained 990,000 DECO into each pool).
- **BUG 2 (accounting):** on Arc the sell tx's gas (native USDC) pollutes the
  USDC-view balance-delta sell measurement. Proven via Transfer event: AMM
  paid 0.099406 USDC, script logged 0.097326, gap = sell gas 0.00208 USDC.

## Fixes applied to volume.js (coordinator, 2026-11-16 ~14:22 WIB)
1. `cleanupSell()` now sells ONLY (current DECO balance − baseline captured at
   `init()`), capped at (failed rounds + 1) × buy size; skips entirely if no
   baseline was recorded. Never touches the burner's 990,000 DECO supply.
2. Sell accounting adds the sell tx's gas back on Arc too (`gasPollutesBase`
   flag + `gasAffectsBaseDelta()`), converted to base units via
   `gasCostInBaseUnits()` (18-dec native → 6-dec USDC view, /1e12). The first
   attempt at fix 2 added raw 18-decimal wei to the 6-decimal balance and
   inflated sold totals ~1e12x — caught by the re-proof, fixed the same way.
3. Self-test passes; syntax clean.

## Proof run 2 (fixed code) — GO
- Arc 5/5, 0 failed: bought 0.5 USDC, sold 0.49703 USDC, fees 0.00297 USDC,
  DECO bought = sold = 490.304700714678834759, gas 0.02126725 USDC.
  Cleanup: "no leftover DECO — nothing to sell". Summary
  `volume-logs/2026-11-16-arc-summary-142344.json`.
  NOTE: the earlier 14:22 Arc run (5 rounds, before the decimals fix) has
  WRONG sell amounts in its log lines + summary (`...-arc-summary-141638.json`
  is polluted by the cleanup dump; `...-142229.json` has the 1e12x sell
  inflation). On-chain trading was correct in both; only the reported
  sold/fees figures are wrong. Use the 142344 summary for Arc proof figures.
- Robinhood 5/5, 0 failed: fees 0.00000272506779422 ETH, gas 0.0000057743 ETH,
  ~12s/round. Cleanup sold nothing. Baseline 990,000 DECO intact.
- LitVM 5/5, 0 failed: fees 0.00000272506779422 zkLTC, gas 0.00000627326 zkLTC,
  ~3.4s/round, 11 txs (1 DECO MaxUint256 approval + 10 round txs).
  Cleanup sold nothing. Baseline 990,000 DECO intact.
- Projected 1,000 rounds: Arc ~3.0h / ~4.25 USDC, Robinhood ~3.3h /
  ~0.00115 ETH, LitVM ~1h / ~0.00125 zkLTC.

## First run (1,000 rounds/chain) — PARTIAL, 2,066/3,000 (agent e1fb9cdf, done ~16:20 WIB)
All figures below VERIFIED on-chain by the coordinator (summaries read,
balances/reserves/nonces/first-tx receipts re-checked via RPC).
- LitVM COMPLETE 997/1,000 (3 failed, socket hang-ups, leftovers recovered by
  cleanup): 1,999 txs, nonce 29→2028, bought 0.0998 / sold 0.09937066 /
  fees 0.00042934 zkLTC, gas 0.00115844293. Burner DECO exactly 990,000.0.
  Pool 10,000 / 0.001533177291331013. First tx
  0x174263fc3bc07320211f8a45f9b408c2d847bbced0a644a50e0f927c3acbeffb.
  DECO sold (677,930.21) exceeds logged bought (677,165.74) by 764.47 = the
  3 unlogged failed-round buys, recovered by cleanup — accounting reconciles
  exactly (burner spend = recorded gas + logged fees + failed-round net base
  loss 0.00010329 + proof gas).
- Arc PARTIAL 476/1,000, 0 failed: killed 16:00:07 WIB by the script's own
  top-level handler — a socket hang-up in the unretried balanceGuard between
  rounds (NOT a gas trip: 2.0242575865 of 10 USDC spent, gas 25 gwei throughout).
  952 txs, nonce 52→1004, bought 47.6 / sold 47.317225 / fees 0.282775 USDC,
  DECO bought = sold exactly 46,033.128619193211102414. Burner DECO exactly
  baseline 990,000.000134550599182298. Pool 9,999.999865 / 10.351973 USDC.
  First tx 0xc9ad165f28491f4bed2e22044d63e9b29b352e6a8c79eb6e8f183210745a56eb.
  Summary stoppedReason "error".
  NOTE: burner native USDC after (127.3756521135) is HIGHER than before
  (~109.73) because a 2-hourly Circle faucet claim (+20 USDC) landed mid-run —
  the run's own gas (2.024 USDC) comes from the summary, not the delta.
- Robinhood PARTIAL 593/1,000: killed by a VM REBOOT ~16:18–16:19 WIB
  (uptime "up 0 min", /tmp wiped) mid-round-594, no summary written.
  1,187 txs on-chain (nonce 30→1217); 1,186 logged + 1 orphan. Bought 0.0593 /
  sold 0.058972798204 / fees 0.000327201796 ETH, gas 0.00068535421.
  DECO bought = sold = 469,741.673708667455 (logged). First tx
  0xf9276b50c9bdb40ae84262d7b0364272093c23bb17f67719f066a8d9e0c735d5.
  ORPHAN BUY: round 594's buy landed despite the lost send response, tx
  0xc47bcadf837ffb1dde18042f1f26cd3f3a4af89b1aeb6acd53d72968ba55d1d3
  (nonce 1216, block 154018748, status 1) — burner held 990,697.119 DECO.
- Totals: 2,066/3,000 rounds (68.9%), 4,138 txs on-chain.
- The reboot also killed the parent's separate Velana volume run; a resume
  (819 rounds) was already running when the coordinator checked at ~16:25 WIB
  (PID 2028, `volume.js --chain velana --rounds 819 --live`). NOT the
  coordinator's run — do not touch it.

## Hardening fix (coordinator, 2026-11-16 ~16:26 WIB)
- `balanceGuard()` in volume.js did raw unretried RPC reads — the Arc
  first-run killer. Both reads now use retryAsync (3x backoff). Self-test
  passes. This fixes the demonstrated failure mode without touching the
  cron's no-retry rule.

## Robinhood orphan sell-back (coordinator, 2026-11-16 ~16:27 WIB)
- New reusable tool: ~/workspace/sniper/sell-deco.js (exact-amount sell,
  dry-run default, testnet guard, allowance check). Sold exactly
  697.119046890119032528 DECO, tx
  0x27758991e9150f87b23599ae959323df616009e4d53f9661f8c72e9bd8e4dc77
  (block 154019837, gas 62,459). Pool restored to exactly 10,000 DECO /
  0.00133102924916131 ETH; burner DECO exactly 990,000.0.

## Top-up runs — IN PROGRESS (agent 9d88af50, spawned ~16:28 WIB)
- Arc 524 rounds, Robinhood 407 rounds, LitVM 3 rounds, in parallel, with the
  hardened script + Arc gas pre-check. Logs:
  `volume-logs/2026-11-16-topup-<chain>.log`. Expected ~1.6h (Arc), ~1.4h
  (Robinhood), <1 min (LitVM). Combined first-run target: 1,000/1,000/1,000.
- V4 RESUME (Robinhood pool + live sniper) still queued behind the Robinhood
  top-up run — do NOT start v4 txs until the top-up agent reports Robinhood done.

## Daily cron — CREATED
- `sniper-daily-volume`, daily ~11:11 Asia/Jakarta, owner
  goal:deco-pools-and-sniper-trading. 100 rounds/chain/day (600 txs/day),
  sequential (Arc → Robinhood → LitVM), Arc gas pre-check, short daily
  summary to the main chat (NOT quiet-on-success). First run Tue 2026-11-17
  11:11 WIB.

## STANDING REPORTING RULE (deco, via parent 2026-11-16 ~15:04 WIB)
Applies to the coordinator's FINAL REPORT (report only — no change to runs).
Per chain the final report MUST include:
- Status: rounds completed / failed.
- Balance check: burner DECO + gas-token BEFORE/AFTER, pool reserves.
- Gas costs.
- Transaction URLs: FIRST + LAST tx per chain, plus pool + burner explorer links.
- Full tx hashes stay in the volume logs (do NOT dump all hashes in the report).
Explorer patterns:
- Arc: https://explorer.testnet.arc.io/tx/<hash>
- Robinhood: https://explorer.testnet.chain.robinhood.com/tx/<hash>
- LitVM: https://explorer.testnet.liteforge.zeeve.net/tx/<hash>
(Address pages use /address/<addr> on the same explorers.)
NOTE (superseded): the parent has ALREADY updated the cron body (seen 2026-11-16
~16:25 WIB): balance snapshot BEFORE step, standing reporting rule applied to
daily delivery (status + balances + gas + tx links per chain, explorer URL
patterns included), and a Velana note: "Velana (484148) is being added as a
4th chain by a separate build — the parent updates this job when it lands; do
not add it yourself." Do NOT add Velana to the cron. The cron's step 4
no-retry rule ("do NOT retry it the same day") stays per the parent's
explicit instruction — the coordinator did NOT change it. Flag in the final
report that the first run proved runs can be cut short by transient infra
failures, so the parent may want to decide: shortfall top-ups in the cron, or
accept partial days. The script-level fix (balanceGuard retry, below) already
removes the Arc failure mode without touching the cron's no-retry rule.

## V4 RESUME ORDER (deco, via parent 2026-11-16 ~15:05 WIB)
Deco: "Do not pause anymore anything. Go run it all." The Robinhood v4 pool +
live position-mode sniper (paused by him 2026-11-16 04:24 WIB) is APPROVED to
resume — ONLY AFTER the Robinhood VOLUME run finishes (same burner, same
chain; never send v4 txs while the volume run is sending or nonces collide).
Volume-run progress at 15:05 WIB: Arc 198/1000, Robinhood 185/1000,
LitVM 722/1000 — Robinhood volume run expected done ~17:50 WIB.
Resume steps, in order:
1. Verify the two paused-attempt approval txs still in place
   (DECO→Permit2 1M, tx 0x5c2dd5a71666bc3ec1c9d9a05f53decc9c88c7c1f5aac38b71aeda2e1b20c540;
   Permit2→PositionManager 1M exp 2100-01-01, tx
   0x1ef101cb7e41ff8240ae6f135527f4d9b0f3a2792f071e38513b4175cde7b42a),
   then run ~/workspace/sniper/create-robinhood-pool.js (DECO/ETH v4 pool,
   fee 3000, tick spacing 60). Check LIVE burner Robinhood balance first:
   seed max 0.003 test ETH + ≤100,000 DECO, keep ≥0.005 test ETH reserve —
   shrink the seed if the balance is lower than expected (balance was
   ~0.00893 ETH after proofs, minus ~0.00115 ETH volume-run gas → expect
   ~0.0078 ETH at volume-run end, so the seed will likely need shrinking to
   ~0.0025-0.0028 ETH).
2. Then run the position-mode sniper LIVE on Robinhood, target-token mode
   (DECO): set LIVE.enabled=true in config + use --live. FIRST live trade
   MUST be minimal (0.0005 test ETH) — the v4 UniversalRouter swap encoding
   has NEVER executed on-chain. Testnet-only guard stays on. Read sniper.js
   / config.js first for how trade size is set.
3. Report back with pool ID/address, seed amounts, every trade with tx
   hashes + explorer URLs, and balances — same reporting standard as the
   volume runs (status + balance check + gas + tx links).
Safety: testnet only, burner only, never print/log keys. The daily cron's Arc
gas-spike skip and no-retry rules are safety rules, not pauses — they stay.
This v4 resume becomes part of the coordinator's FINAL REPORT (after the
volume first run completes and is verified).

## V4 RESUME — Robinhood DECO/ETH pool + live position-mode sniper (DONE 2026-11-16 ~18:28–18:50 WIB)

### Pool creation + seed (18:28 WIB)
- Approvals verified on-chain first: DECO→Permit2 1,000,000 ✓; Permit2→PositionManager
  1,000,000 exp 2100-01-01 ✓; Permit2→UniversalRouter 0 (approved by the pool script).
- Script bug fixed before the run: `v4.poolKeyTuple is not a function` — defined in
  dex/v4.js but missing from module.exports. One-line fix. The staticCall guard caught
  it before broadcast; no harm. The run's Permit2→UniversalRouter approval had already
  landed: tx 0x0c6150724241e1b2980edd50f413b4ddb2543e15290af65283150f2e2e705f41
  (block 154055302, gas 47,626).
- Seed shrunk: burner held only 0.007208226250995738 ETH, so the original 0.003 ETH /
  100,000 DECO seed would have breached the ≥0.005 ETH reserve. Changed to
  0.0021 ETH + 70,000 DECO (same price, 1 DECO = 3e-8 ETH); reserve after seed 0.005108 ETH.
- Pool ID 0x0c6d73c11e075cd18082b5aae55828c76a3d2b31f2f3e06558d75bd58d0363f7
  (currency0 = native ETH 0x0, currency1 = DECO, fee 3000, tickSpacing 60, hooks 0x0;
  full-range ticks ±887220).
  - initializePool tx 0x86b457ccdf5388df76e8de479715f6b11cc4ebcd2852260ba1e379e49aff7955
    (block 154055404, gas 56,279).
  - Mint tx 0xa5287d3764e0c88f08b4821a066389ffc83a7205167509dc3662232f353c5187
    (block 154055441, gas 372,943).
  - Verified via StateView: sqrtPriceX96 457424009550099325341618706294905, tick 173229,
    liquidity 12112231297329158912. Position NFT tokenId 1070742, burner holds 1.
  - Burner after: 0.005103457770995738 ETH, 920,070.000000000000009454 DECO. The mint
    consumed 69,930 DECO (not 70,000) and 0.0020979 ETH (0.1% liquidity haircut);
    0.0000021 ETH excess from msg.value was NOT refunded (no sweep in the unlock data —
    2.1e-6 test ETH dust, likely sitting in the PoolManager).
  - Results: ~/workspace/sniper/robinhood-pool-results.json.

### Sniper sell() whole-balance BUG — found + FIXED before any live run (18:29 WIB)
- Live-mode sell() in sniper.js sold the burner's ENTIRE DECO balance (balanceOf(BURNER))
  — the burner holds ~920,070 DECO, so the first sell would have dumped it all into the
  v4 pool (same bug class as the volume.js cleanup incident).
- Fix: buy() now measures the actual DECO received (balance delta across the buy, live
  only) and stores pos.decoReceived; sell() sells ONLY that amount (falling back to the
  quoted expectedOut), refuses to sell blind if neither is available, and caps at the
  wallet balance if lower. Dry-run behavior unchanged.

### BLOCKER 1 — the v4 Quoter is BROKEN on Robinhood testnet (diagnosed 18:30–18:32 WIB)
- Dry-run buy failed: Quoter call reverted with empty returndata.
- The contract at the config's quoter address 0x8dc178efb8111bb0973dd9d722ebeff267c98f94
  has 6,118 bytes of code and a 10-selector dispatcher — but NONE is any quote function
  (no quoteExactInputSingle new 0x6501a3ce or old 0x3d20c12b, no quoteExactInput, no
  quoteExactOutputSingle). It DOES expose unlockCallback (0x91dd7346) and poolManager()
  (0xdc4c90d3, returns the correct PoolManager). It is some OTHER v4 periphery contract,
  NOT a Quoter. The config's assumption ("docs-listed mainnet v4 deployment is live on
  testnet") is WRONG for the Quoter. Uniswap's own v4 Deployments docs now warn not to
  assume the same addresses across chains.
- RESOLUTION — manual StateView-based quote (dex/v4.js, quoteExactInputSingleManual):
  exact UniV3 sqrtPrice math in BigInt from StateView (sqrtPriceX96 + liquidity).
  Valid because the pool is full-range single-position (constant liquidity across the
  swap); documented in code as not for multi-position pools. Rounding is conservative
  (output slightly under-estimated).
- Verification (test-manual-quote.js, VERDICT PASS): buy 0.0005 ETH -> 13,426.322985672469572612
  DECO, agrees with an independent constant-product computation to 5.2e-9 DECO (rounding
  noise); sell quote agrees EXACTLY (diff 0); tiny-buy tracks the spot price; true
  round-trip loss 0.54% (2x 0.3% fee) as expected.

### BLOCKER 2 — UniversalRouter reverts SliceOutOfBounds on EMPTY hookData (diagnosed 18:33–18:40 WIB)
- With the manual quote fixed, the dry-run buy/sell tx gas estimation failed:
  execution reverted, custom error 0x3b99b53d = SliceOutOfBounds() (identified by
  computing candidate selectors).
- Router probes (all read-only eth_call): execute() with empty commands OK; V4_SWAP with
  empty actions OK (dispatch + unlock work); WETH9() and permit2() views REVERT with
  empty data (this router is a UniversalRouter variant without those views);
  poolManager() returns the correct PoolManager.
- Action isolation: SETTLE_ALL alone OK; TAKE_ALL alone reverts with a sensible delta
  error (expected, no delta); SWAP_EXACT_IN_SINGLE alone -> SliceOutOfBounds.
  SWAP_EXACT_IN (0x07) also -> SliceOutOfBounds.
- ROOT CAUSE FOUND: swap-only probe with hookData '0x00' (1 byte) -> swap EXECUTED
  (reverted CurrencyNotSettled 0x5212cba1, the expected unsettled-delta error). Empty
  hookData '0x' is what breaks the router's parse. Our pool has hooks = 0x0, so hookData
  is never read by any hook — the byte is inert.
- FIX (dex/v4.js encodeV4Swap): hookData '0x00' instead of '0x', with an explanatory
  comment. Full buy + sell simulations then PASS via eth_call (buy gas est. 118,196;
  sell gas est. 138,006 — the Permit2 path works, allowances in place).

### LIVE PROOF RUN — cycle 1, 0.0005 ETH (18:41–18:43 WIB) ✓
- LIVE.enabled=true for the run; set back to false afterwards.
- Command: node sniper.js --chain robinhood --mode target --buy-amount 0.0005
  --max-hold 120 --poll-seconds 30 --duration-seconds 900 --live
  Log: ~/workspace/sniper/v4-logs/live-proof-2026-11-16.log
- BUY tx 0xbb654db544b24de3b10d8ff945ce3332c6d59fdf3925b3be9d4ffb1b464b55ab
  (block 154059449, status 1, gas 116,107). Received 13,426.322985672469572906 DECO
  (quoted 13,426.322985672469572612 — actual 294 wei MORE than quoted).
- SELL tx 0x0ca08b1c3670c3dc3dd9fec3c572f4fc7cd5d97e1c89acb7d07550570dca1d5f
  (block 154060097, status 1, gas 133,490). Sold exactly the position size
  13,426.322985672469572906 (wallet held 933,496.32 — the whole-balance fix held).
  Exit reason: max hold 120s reached.
- Balances: DECO 920,070.000000000000009454 before AND after (exact round-trip);
  ETH 0.005103457770995738 -> 0.005098252735517605 (net cost 0.000005205035478133:
  ~0.00000271 swap fees + 0.00000249597 gas at 0.01 gwei).
- Process killed by the coordinator right after the sell confirmed, before the next
  poll cycle could re-buy. No second position.

### LIVE CYCLE 2 — 0.001 ETH, normal size (18:43–18:49 WIB) ✓
- Command: node sniper.js --chain robinhood --mode target --buy-amount 0.001
  --max-hold 300 --poll-seconds 30 --duration-seconds 900 --live
  Log: ~/workspace/sniper/v4-logs/live-cycle2-2026-11-16.log
- BUY tx 0x832bbf505ed31a3ada31b2d45e7e0c23a5db69f7d71aea9867efb1040791aa9c
  (block 154060276, status 1, gas 104,720). Received 22,505.683874282085782872 DECO
  (quoted 22,505.683874282109825958 — actual 24 wei LESS than quoted).
- SELL tx 0x538a71fade7bca1a6c835df1a9c3ba2ebe2aac7d74ae9033a8b9819418d95ddd
  (block 154061669, status 1, gas 122,283). Sold exactly the position size
  22,505.683874282085782872 (wallet held 942,575.68 — fix held again).
  Exit reason: max hold 300s reached.
- Balances: DECO 920,070.000000000000009454 before AND after (exact);
  ETH 0.005098252735517605 -> 0.005090952897704924 (net cost 0.000007299837812681).
- Process killed right after the sell confirmed. No open positions left.

### V4 totals (both cycles)
- 4 txs, all status 1. Total gas 476,600 units = 0.000004766 ETH at 0.01 gwei.
- Total net cost 0.000012504873290814 ETH (0.000004766 gas + ~0.000007739 swap fees).
- Burner DECO unchanged at 920,070.000000000000009454. Nonce 2035 -> 2039.
- V4 pool after: sqrtPriceX96 456718897467342479052337758060123, tick 173198
  (seed 173229; -31 ticks — the pool kept the 0.3% fees from both round-trips),
  liquidity UNCHANGED 12112231297329158912.
- SimpleAMM pool untouched by the v4 trades: 10,000 DECO / 0.001559136679004262 ETH.
- LIVE.enabled is FALSE again (config.js line 114, re-verified by grep).
- NOTE for future runs: the sniper re-buys after a position closes (target mode keeps
  watching until --duration-seconds). For single-cycle proofs, run it in the background
  and kill it right after the sell confirms (poll-seconds 30 gives a ~30s window), or
  add a --one-cycle flag to sniper.js.

### Final state (verified live ~18:50 WIB)
- Arc: burner DECO 990,000.000134550599182298; USDC 144.8355964135; SimpleAMM pool
  9,999.999865449400817702 DECO / 10.663229 USDC; nonce 2052; gas 25.0 gwei.
- Robinhood: burner DECO 920,070.000000000000009454; ETH 0.005090952897704924;
  SimpleAMM pool 10,000 DECO / 0.001559136679004262 ETH; nonce 2039; gas 0.01 gwei.
- LitVM: burner DECO 990,000.0; zkLTC 0.047225055081104498; SimpleAMM pool
  10,000 DECO / 0.001534865198895502 zkLTC; nonce 2034; gas 0.01 gwei.
- Volume first-run last txs: Arc 0x7b118c50eb8b3132b80192212df0575a9558ee5e66c6f1e7a94897e8c6f833d2
  (sell, top-up round 524); Robinhood 0x143cfd95553953fa70771ac9a5720858a72af4ae768c3355551982b1e96b7f0c
  (sell, top-up part 3 round 240); LitVM 0xe1eb3cb4d7466fa22b7fa1307add70efe96811ddbc27b7de228db95c55dd9c0a
  (sell, top-up round 3).
