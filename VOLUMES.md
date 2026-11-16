# Daily transaction volumes — volume sniper, first run (2026-11-16)

Buy-then-sell-back rounds against deco's own SimpleAMM pools. One round =
1 buy + 1 sell (2 txs). All figures verified on-chain; per-chain details in
`volume-summaries/volume-summary-<chain>.json`; full per-tx logs in
`volume-logs/2026-11-16-<chain>.jsonl`. Full incident + fix record in
`volume-proof-2026-11-16.md` (3 chains) and `velana-build.md` in the
deco-tokens repo (Velana).

**As of 23:10 GMT+7, Nov 16, 2026.** All four burner first runs are COMPLETE —
4,000 rounds, 8,007 txs total — plus the Circle wallet's DM/USDC run below
(100 rounds, 201 txs). **Grand total: 4,100 rounds, 8,208 txs**
(8,210 incl. the Circle test round's 2 txs).

| Chain | Rounds | Transactions | Bought | Sold | Fees paid | Gas spent | Status |
|---|---|---|---|---|---|---|---|
| Arc Testnet | 1,000 / 1,000 | 2,000 | 100.0 USDC | 99.405931 USDC | 0.594069 USDC | 4.253 USDC | ✅ Complete |
| Robinhood Testnet | 1,000 / 1,000 | 2,002 | 0.1001 ETH | 0.0995441 ETH | 0.0005559 ETH | 0.001156 ETH | ✅ Complete |
| LitVM LiteForge | 1,000 / 1,000 | 2,005 | 0.1001 zkLTC | 0.099669 zkLTC | 0.000431 zkLTC | 0.0011619 zkLTC | ✅ Complete |
| Velana Testnet | 1,000 / 1,000 | 2,000 | 0.1 VELA | 0.0994447 VELA | 0.0005553 VELA | ~0.00000000081 VELA | ✅ Complete |
| Arc (Circle) | 100 / 100 | 201 | 10.0 USDC | 10.038073 USDC | −0.038073 USDC* | 0 (not deducted) | ✅ Complete |
| **Total** | **4,100 / 4,100** | **8,208** | | | | | |

Notes:
- Robinhood's 2,002 txs include an orphan buy + orphan sell-back from a VM
  reboot mid-round-594 (both recovered; balances reconcile exactly). 73 round
  attempts failed along the way (nonce collisions after crash-restarts) and
  were retried — the 1,000-round target was still met.
- LitVM's 2,005 txs include 1 approval + 1 cleanup sell + 3 failed attempts
  (socket hang-ups); a 3-round top-up closed the gap to 1,000.
- Velana ran in 4 parts (181 + 490 + 33 + 296) across 2 VM reboots and 1
  RPC-502 crash. Every interruption was reconciled exactly on-chain
  (unlogged sells found by block scan, diff 0 wei; one leftover sold back
  manually). DECO bought = sold = 733,074.4997 (diff 0.0). The 502 crash
  exposed an ethers v6 `sent.wait()` unhandled-rejection bug — fixed in
  `volume.js` with a manual `waitForReceipt()` poller (502s now fail a
  round instead of killing the process).
- Proof runs (5 rounds per chain, all clean) are not in the table above.
- *Arc (Circle): the run was net-POSITIVE in USDC (+0.038073) because round
  61 double-sold — the first sell executed on-chain while the CLI reported
  failure, and the recovery sold the same 98.36 DM again (both sells
  verified via Swap events). DM delta −98.362913570668475149 (from the
  wallet's 99.9T DM holdings). A VM reboot also interrupted round 8 (buy
  landed, sell never ran — reconciled exactly + sold back; run resumed at
  round 9). Runner: `volume-circle.js` (writes via `circle wallet
  execute`); log `volume-logs/2026-11-16-circle-dm.jsonl`, segment summary
  `...-summary-resume.json`. Runner fixed after the run: a failed write
  now re-checks on-chain state before any retry. Full record:
  `circle-stack-2026-11-16.md` in the deco-tokens repo.

## First / last transactions

| Chain | First tx (first run) | Last tx |
|---|---|---|
| Arc | [0xc9ad165f…](https://explorer.testnet.arc.io/tx/0xc9ad165f28491f4bed2e22044d63e9b29b352e6a8c79eb6e8f183210745a56eb) | [0x7b118c50…](https://explorer.testnet.arc.io/tx/0x7b118c50eb8b3132b80192212df0575a9558ee5e66c6f1e7a94897e8c6f833d2) |
| Robinhood | [0xf9276b50…](https://explorer.testnet.chain.robinhood.com/tx/0xf9276b50c9bdb40ae84262d7b0364272093c23bb17f67719f066a8d9e0c735d5) | [0x143cfd95…](https://explorer.testnet.chain.robinhood.com/tx/0x143cfd95553953fa70771ac9a5720858a72af4ae768c3355551982b1e96b7f0c) |
| LitVM | [0x174263fc…](https://explorer.testnet.liteforge.zeeve.net/tx/0x174263fc3bc07320211f8a45f9b408c2d847bbced0a644a50e0f927c3acbeffb) | [0xe1eb3cb4…](https://explorer.testnet.liteforge.zeeve.net/tx/0xe1eb3cb4d7466fa22b7fa1307add70efe96811ddbc27b7de228db95c55dd9c0a) |
| Velana | [0xe9ab414a…](https://velanachain.com/explorer/#/tx/0xe9ab414ad7ed8f7f73b2275fe29650d7bf29986630618b95a7b9f8aaa0243405) | [0xb5375c0a…](https://velanachain.com/explorer/#/tx/0xb5375c0a37a26ebf538c701de4ab73cf2b23afc06bee9080478510473959c3bb) |
| Arc (Circle) | [0x324ffce2…](https://explorer.testnet.arc.io/tx/0x324ffce25b9fefaa8078fd75e133f5bb635a99fbb346af6a2859a554c85dcf92) | [0x988cb369…](https://explorer.testnet.arc.io/tx/0x988cb369022d1698ee0386d5ae08ac9e3f73297b139024aa919b9eee99b7c982) |

## Pool reserves after the first run (Velana checked on-chain 19:55 GMT+7; other chains 18:49 GMT+7, unchanged since)

| Chain | Pool | DECO reserve | Base reserve |
|---|---|---|---|
| Arc | `0x3137C615F3f3B1e7C8F75390F8ccb128f4D11A3A` | 9,999.9999 | 10.663229 USDC |
| Robinhood | `0xC72A740883E93E899C02036f96841869A5BdbbDC` | 10,000 | 0.0015591 ETH |
| LitVM | `0x3137C615F3f3B1e7C8F75390F8ccb128f4D11A3A` | 10,000 | 0.0015349 zkLTC |
| Velana | `0xa81056EF621c952B5Fc033D7db159a0Da4ED5163` | 10,000 | 0.0015586 VELA |
| Arc (Circle) | `0x53661d12527e02019d991d2f24bf4b6661a96ba7` | 10,098.3629 DM | 9.962521 USDC |

Burner DECO after: 990,000 on Arc, LitVM and Velana; 920,070 on Robinhood
(70,000 DECO went into the Uniswap v4 pool — see below). Burner + pool =
exactly 1,000,000 DECO on every chain (Robinhood: + 70,000 in the v4 pool).

## Daily schedule

From Tue 2026-11-17 the volume sniper runs **100 rounds/chain/day**
(200 txs/chain/day, 800 txs/day across 4 chains) at ~11:11 GMT+7, chains
sequential, Arc gas pre-check (skip Arc if gas > 100 gwei). This file is
updated with each day's totals.

## Uniswap v4 pool (Robinhood) — live trades, not just volume

The position-mode sniper (`sniper.js`) also traded a REAL Uniswap v4
DECO/ETH pool on Robinhood Testnet — pool ID
`0x0c6d73c11e075cd18082b5aae55828c76a3d2b31f2f3e06558d75bd58d0363f7`
(fee 3000, tickSpacing 60, full-range), seeded 0.0021 ETH + 70,000 DECO
(position NFT #1070742, held by the burner). Two full buy→sell cycles,
all 4 txs confirmed, total net cost 0.0000125 ETH, burner DECO exactly
unchanged. Details + tx links in `robinhood-pool-results.json`,
`v4-logs/` and `volume-proof-2026-11-16.md`.

Known v4 gotchas on Robinhood testnet (both fixed in `dex/v4.js`):
- The docs-listed Quoter address is NOT a Quoter — the sniper uses a manual
  StateView-based quote instead.
- The UniversalRouter reverts on empty hookData — swaps encode hookData `0x00`.
