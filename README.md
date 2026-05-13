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

## Live-mode runbook (Batch 3)

When you're ready to flip from log to live mode:

### 1. Fund the platform mint key wallet

Send a small amount of ION (~3–5 ION suffices for ~50 mints' worth of gas) from your main wallet to the mint key wallet address. This both deploys the V4 wallet contract on-chain *and* leaves headroom for the watcher to pay gas on mint authorizations. Each mint costs ~0.1–0.15 ION in gas. Top up later when balance dips.

### 2. Add the seed phrase as a GitHub Actions secret

Go to **Settings → Secrets and variables → Actions → Secrets → New repository secret**.

- Name: `MINT_KEY_MNEMONIC`
- Value: the 24-word seed phrase for the mint key wallet, separated by single spaces

GitHub masks the value in logs. Paste using the careful protocol — click into the input field, paste, wait 2 seconds (in case of long-paste truncation issues), then save.

### 3. Flip the mode variable

In **Variables**, edit `WATCHER_MODE` (or create it if missing):

- Value: `live`

### 4. Trigger a manual run

**Actions → ION NFT Watcher → Run workflow** → leave mode as the default (`log`) or override to `live` via the dropdown. The repository variable governs scheduled runs going forward.

Watch the logs for:

- `[live] mint key wallet derived: UQ...`
- `[live] mint key wallet balance: N nano` (should match what you funded)
- `[live] verifying source tx for burn ...`
- `[live] prepared mint: collection=..., index=N, recipient=...`
- `[live] ✓ mint broadcast tx=... seqno=N`

If any of those fail, the watcher safely refuses the mint and logs why. No funds move until all checks pass.

### 5. Watch the NFT land

Within ~30 seconds of the mint broadcast, the NFT contract gets deployed at a deterministic address (computed from the collection + item index). The burner's wallet will list it under their NFT collection within 1–2 minutes (depends on the wallet's indexer).

### 6. Operational safety

- **MAX_MINTS_PER_RUN** (default 5): hard cap on actual mint signings per tick
- **Address consistency check**: preflight verifies the derived wallet address matches `PLATFORM_MINT_KEY_ADDRESS` var
- **Balance check**: refuses to mint if balance < 0.5 ION
- **Split verification**: refuses to mint if the source tx doesn't include valid creator + treasury legs
- **Idempotency**: each burn is keyed by tx_hash; reruns don't double-mint

### 7. Recovery

- Watcher down: nothing happens, ION stays at burn pocket, mint is queued for next successful run
- Mint key compromised: revoke by generating a new mint key wallet, updating env var, transferring on-chain ownership of each collection (separate procedure)
- Bug surfaces: set `WATCHER_MODE=log` immediately to halt mint signings while preserving detection
