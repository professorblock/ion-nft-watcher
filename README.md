# ion-nft-watcher

Proof-of-burn watcher for [ION Hub | NFT Studio](https://nft.ionhub.io). Runs as a free GitHub Actions cron job every 5 minutes — observes incoming burns to per-collection burn pockets on Ice Open Network, validates the splits, and (in live mode) signs mint authorizations so the NFT lands in the burner's wallet.

Sister project to [`ion-nft-studio`](https://github.com/professorblock/ion-nft-studio).

## How it works

```
User clicks "Burn 1000 ION to Mint" on nft.ionhub.io
   ↓
Frontend builds one wallet transaction with three messages:
   ┌───────────────────────────────────────────┐
   │  → 800 ION to per-collection burn pocket  │  (permanently destroyed)
   │  → 180 ION to creator wallet              │
   │  →  20 ION to platform treasury           │
   └───────────────────────────────────────────┘
   ↓
This watcher (running every 5 min on GitHub Actions):
   1. Reads tracked-collections.json + last-checked.json
   2. Fetches new transactions for each tracked burn pocket
   3. For each new burn:
        - Idempotency check (skip if already processed)
        - Verify burn ≥ expected amount for that collection
        - Verify the sender's tx also paid creator + treasury legs
        - Sign the mint message → NFT appears in burner's wallet
   4. Commits state changes back to the repo
```

The repo's `state/` directory is the persistent store — every change is a public git commit, so the entire history of burns + mints is auditable.

## Modes

| Mode | Behaviour |
| ---- | --------- |
| `log` (default) | Read-only. Detects burns, validates expectations, logs what it *would* do. No funds move. No keys used. |
| `live` | Detects, validates, and signs mint authorizations. Requires `MINT_KEY_MNEMONIC` secret. |

Mode is controlled by the `WATCHER_MODE` repository variable, or overridden per-run via the workflow_dispatch input.

## Setup

Required Actions configuration (Settings → Secrets and variables → Actions):

**Variables** (public, fine to commit):
- `PLATFORM_TREASURY_ADDRESS` — wallet that receives the platform's 2% slice
- `PLATFORM_MINT_KEY_ADDRESS` — public address of the mint authority wallet
- `WATCHER_MODE` — `log` or `live` (defaults to `log`)

**Secrets** (encrypted):
- `MINT_KEY_MNEMONIC` — 24-word seed phrase for the mint authority wallet (live mode only)

## Local development

```bash
nvm use
npm install
PLATFORM_TREASURY_ADDRESS=UQ... PLATFORM_MINT_KEY_ADDRESS=UQ... npm run watch
```

A single tick runs and exits. Repeat to simulate the cron.

## Operational guarantees

- **Idempotent.** Each burn is keyed by its tx hash; reruns won't double-mint.
- **Bounded per run.** Hard cap of 50 burns per tick, prevents runtime overruns.
- **Single concurrency.** GitHub Actions concurrency lock prevents two ticks racing on state.
- **Read-only by default.** Live mode is a separate explicit flag.

## License

MIT
