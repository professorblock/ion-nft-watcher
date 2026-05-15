/**
 * index.ts
 * ────────
 * Main entrypoint for the ION Hub NFT watcher. Designed to run as a
 * GitHub Actions cron job (every 5 min). One run = one tick:
 *
 *   1. Read tracked PoB collections + processed-burn log + pocket cursors
 *   2. For each pocket: fetch new transactions since its last cursor
 *   3. For each new transfer:
 *        - Skip if already processed (idempotency)
 *        - In "log" mode: just record it — no fund movement
 *        - In "live" mode: validate splits, sign mint, record results
 *   4. Persist state files (committed back to repo by the workflow step)
 *
 * Live-mode signing is intentionally NOT implemented in this batch.
 * Batch 1 is read-only by design: prove detection works on real burns
 * before we add anything that touches keys.
 */

import BN from "bn.js";
import { Address, toNano } from "ton";
import {
  MAX_BURNS_PER_RUN,
  MAX_TXS_PER_POCKET_PER_RUN,
  WATCHER_MODE,
  POB_PLATFORM_FEE_BPS,
  getMintKeyAddress,
  getTreasuryAddress,
} from "./ion-config";
import { fetchIncomingSince, IncomingTransfer, getClient } from "./ion-rpc";
import {
  isAlreadyProcessed,
  ProcessedBurn,
  readLastChecked,
  readProcessedBurns,
  readTrackedCollections,
  TrackedCollection,
  writeLastChecked,
  writeProcessedBurns,
} from "./state-store";
import { deriveBurnPocket } from "./burn-pocket";
import { getMintKeyWallet, getMintKeyBalance, sendMint } from "./wallet";
import { buildMintBody } from "./mint-builder";
import { verifyBurnSplits, computeExpectedSplits } from "./source-tx-verify";

/** Hard cap on mints actually signed per run. Conservative for early days. */
const MAX_MINTS_PER_RUN = Number(process.env.MAX_MINTS_PER_RUN ?? "5");
/** Minimum mint key wallet balance to attempt minting (gas headroom). */
const MIN_MINT_KEY_BALANCE_NANO = toNano("0.5");

interface RunSummary {
  mode: string;
  collections_tracked: number;
  pockets_polled: number;
  new_burns_detected: number;
  rejected: number;
  would_mint: number;
  errors: string[];
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log("─".repeat(60));
  console.log(`ION NFT Watcher tick @ ${startedAt}`);
  console.log(`Mode: ${WATCHER_MODE}`);
  console.log("─".repeat(60));

  // Sanity: verify required addresses are configured. In log-mode, missing
  // values are warnings (we can still detect). In live-mode, hard fail.
  const treasury = getTreasuryAddress();
  const mintKey = getMintKeyAddress();
  if (!treasury) {
    const msg =
      "PLATFORM_TREASURY_ADDRESS not set. Required for split validation.";
    if (WATCHER_MODE === "live") throw new Error(msg);
    console.warn(`[warn] ${msg}`);
  }
  if (!mintKey) {
    const msg = "PLATFORM_MINT_KEY_ADDRESS not set. Required for live mode.";
    if (WATCHER_MODE === "live") throw new Error(msg);
    console.warn(`[warn] ${msg}`);
  }

  const tracked = readTrackedCollections();
  const processed = readProcessedBurns();
  const cursors = readLastChecked();

  const summary: RunSummary = {
    mode: WATCHER_MODE,
    collections_tracked: tracked.length,
    pockets_polled: 0,
    new_burns_detected: 0,
    rejected: 0,
    would_mint: 0,
    errors: [],
  };

  if (tracked.length === 0) {
    console.log("[info] No tracked PoB collections yet. Nothing to poll.");
    console.log(
      "[info] Collections get added to state/tracked-collections.json " +
        "when the wizard deploys a PoB collection (Batch 2 wires this up).",
    );
    finalize(summary, startedAt);
    return;
  }

  // Live-mode preflight: ensure mint key wallet is derivable + funded.
  // Done once before processing any burn so we fail fast.
  let mintedThisRun = 0;
  if (WATCHER_MODE === "live") {
    try {
      const { address } = await getMintKeyWallet();
      const derivedAddr = address.toFriendly({ urlSafe: true, bounceable: false, testOnly: false });
      console.log(`[live] mint key wallet derived: ${derivedAddr.slice(0, 12)}…`);
      const configuredAddr = mintKey?.toFriendly({ urlSafe: true, bounceable: false, testOnly: false });
      if (configuredAddr && configuredAddr !== derivedAddr) {
        throw new Error(
          `Derived mint key address (${derivedAddr}) does not match configured ` +
            `PLATFORM_MINT_KEY_ADDRESS (${configuredAddr}). Refusing to act.`,
        );
      }
      const balance = await getMintKeyBalance();
      console.log(`[live] mint key wallet balance: ${balance.toString()} nano`);
      if (balance.lt(MIN_MINT_KEY_BALANCE_NANO)) {
        throw new Error(
          `Mint key wallet under-funded: ${balance.toString()} nano, need ≥ ${MIN_MINT_KEY_BALANCE_NANO.toString()}`,
        );
      }
    } catch (e: any) {
      const msg = `Live-mode preflight failed: ${e?.message ?? e}`;
      console.error(`[error] ${msg}`);
      summary.errors.push(msg);
      finalize(summary, startedAt);
      return;
    }
  }

  let totalNew = 0;
  for (const coll of tracked) {
    if (totalNew >= MAX_BURNS_PER_RUN) {
      console.log(`[info] Hit MAX_BURNS_PER_RUN (${MAX_BURNS_PER_RUN}); stopping early.`);
      break;
    }

    try {
      const newBurns = await pollCollection(coll, cursors, totalNew);
      totalNew += newBurns;
      summary.pockets_polled++;
      summary.new_burns_detected += newBurns;

      // Record (or attempt) each detected burn
      for (const transfer of (cursorBuf[coll.burn_pocket_address] ?? [])) {
        if (isAlreadyProcessed(processed, transfer.tx_hash)) continue;

        // Hard cap on actual mint signings per run, separate from burn-poll cap.
        if (WATCHER_MODE === "live" && mintedThisRun >= MAX_MINTS_PER_RUN) {
          console.log(
            `[info] Hit MAX_MINTS_PER_RUN (${MAX_MINTS_PER_RUN}); leaving remaining burns for next tick.`,
          );
          break;
        }

        const result = await handleBurn(transfer, coll, treasury);
        processed[transfer.tx_hash] = result;

        if (result.status === "rejected") summary.rejected++;
        if (result.status === "validated") summary.would_mint++;
        if (result.status === "minted") mintedThisRun++;
      }
    } catch (e: any) {
      const msg = `Error polling ${coll.collection_address}: ${e?.message ?? e}`;
      console.error(`[error] ${msg}`);
      summary.errors.push(msg);
    }
  }

  if (WATCHER_MODE === "live") {
    summary.would_mint = mintedThisRun; // re-purpose this counter for "actually minted"
  }

  writeProcessedBurns(processed);
  writeLastChecked(cursors);
  finalize(summary, startedAt);
}

/**
 * Buffer of transfers fetched per pocket during this run, so we can
 * separate the "fetch + cursor advance" pass from the "interpret + record"
 * pass. Lives only for the duration of one cron tick.
 */
const cursorBuf: Record<string, IncomingTransfer[]> = {};

async function pollCollection(
  coll: TrackedCollection,
  cursors: Record<string, { last_lt: string; last_check: string }>,
  burnsSoFar: number,
): Promise<number> {
  const pocket = Address.parse(coll.burn_pocket_address);

  // Sanity-check: re-derive the pocket and confirm it matches the stored value.
  // Catches state-file corruption or accidental edits.
  const derived = deriveBurnPocket(coll.collection_address);
  const derivedStr = derived.toFriendly({ urlSafe: true, bounceable: true, testOnly: false });
  const pocketStr = pocket.toFriendly({ urlSafe: true, bounceable: true, testOnly: false });
  if (derivedStr !== pocketStr) {
    throw new Error(
      `Burn pocket mismatch for collection ${coll.collection_address}: ` +
        `stored=${coll.burn_pocket_address} derived=${derivedStr}`,
    );
  }

  const cursor = cursors[coll.burn_pocket_address] ?? null;
  const sinceLt = cursor?.last_lt ?? null;

  const remaining = MAX_BURNS_PER_RUN - burnsSoFar;
  const limit = Math.min(MAX_TXS_PER_POCKET_PER_RUN, remaining);
  if (limit <= 0) return 0;

  const transfers = await fetchIncomingSince(pocket, sinceLt, limit);

  console.log(
    `[poll] ${coll.collection_address.slice(0, 12)}… → pocket ` +
      `${coll.burn_pocket_address.slice(0, 12)}… ` +
      `since lt=${sinceLt ?? "0"}: ${transfers.length} new transfer(s)`,
  );

  cursorBuf[coll.burn_pocket_address] = transfers;

  // Advance cursor to the highest lt seen (transfers are oldest-first).
  if (transfers.length > 0) {
    const newestLt = transfers[transfers.length - 1].lt;
    cursors[coll.burn_pocket_address] = {
      last_lt: newestLt,
      last_check: new Date().toISOString(),
    };
  } else {
    // Even if nothing new, update last_check so we know the pocket was polled.
    cursors[coll.burn_pocket_address] = {
      last_lt: cursor?.last_lt ?? "0",
      last_check: new Date().toISOString(),
    };
  }

  return transfers.length;
}

async function handleBurn(
  transfer: IncomingTransfer,
  coll: TrackedCollection,
  treasury: Address | null,
): Promise<ProcessedBurn> {
  const detectedAt = new Date().toISOString();
  const expectedMint = BigInt(coll.pob_mint_amount_nano);
  const expectedBurn = (expectedMint * BigInt(coll.pob_burn_pct)) / 100n;

  const burnAmount = BigInt(transfer.value_nano.toString());

  const base: Omit<ProcessedBurn, "status" | "rejection_reason"> = {
    burn_tx_hash: transfer.tx_hash,
    burn_pocket_address: coll.burn_pocket_address,
    burner_address: transfer.source.toFriendly({
      urlSafe: true,
      bounceable: false,
      testOnly: false,
    }),
    amount_nano: transfer.value_nano.toString(),
    detected_at: detectedAt,
  };

  // Reject below-floor burns up front. The frontend should never produce
  // these, but malicious users could craft one manually.
  if (burnAmount < expectedBurn) {
    console.warn(
      `[reject] Burn at ${transfer.tx_hash.slice(0, 10)}… below expected. ` +
        `got ${burnAmount.toString()} expected ≥ ${expectedBurn.toString()}`,
    );
    return {
      ...base,
      status: "rejected",
      rejection_reason: `Burn amount ${burnAmount} below expected ${expectedBurn}`,
    };
  }

  if (WATCHER_MODE === "log") {
    console.log(
      `[log-mode] would mint NFT for burner ${base.burner_address.slice(0, 12)}… ` +
        `from collection ${coll.collection_address.slice(0, 12)}… ` +
        `(burn ${burnAmount} nano, expected ${expectedBurn})`,
    );
    console.log(
      `[log-mode]   in live mode the watcher would also verify the sender's tx ` +
        `included the creator+treasury legs, then sign the mint message.`,
    );
    return { ...base, status: "validated" };
  }

  // ─────────────────────────── LIVE MODE ───────────────────────────
  // Step 1: verify all 3 legs of the source tx
  if (!treasury) {
    return {
      ...base,
      status: "rejected",
      rejection_reason: "Treasury address unavailable in live mode",
    };
  }

  const totalMintNano = new BN(coll.pob_mint_amount_nano);
  const { burnNano, creatorNano, treasuryNano } = computeExpectedSplits(
    totalMintNano,
    coll.pob_burn_pct,
  );

  console.log(
    `[live] verifying source tx for burn ${transfer.tx_hash.slice(0, 10)}… ` +
      `expected splits: burn=${burnNano.toString()}, creator=${creatorNano.toString()}, treasury=${treasuryNano.toString()}`,
  );

  const verification = await verifyBurnSplits(transfer.source, transfer.lt, {
    burnPocket: Address.parse(coll.burn_pocket_address),
    burnNano,
    creator: Address.parse(coll.creator_address),
    creatorNano,
    treasury,
    treasuryNano,
  });

  if (!verification.ok) {
    console.warn(`[live] reject (split mismatch): ${verification.reason}`);
    return {
      ...base,
      status: "rejected",
      rejection_reason: verification.reason,
    };
  }

  // Step 2: check mint key wallet has enough balance for gas
  const balance = await getMintKeyBalance();
  if (balance.lt(MIN_MINT_KEY_BALANCE_NANO)) {
    return {
      ...base,
      status: "rejected",
      rejection_reason: `Mint key wallet balance too low: ${balance.toString()} nano (need ≥ ${MIN_MINT_KEY_BALANCE_NANO.toString()})`,
    };
  }

  // Step 3: read the collection's current next_item_index from chain
  const client = getClient();
  let itemIndex: number;
  try {
    const stack = await client.callGetMethod(
      Address.parse(coll.collection_address),
      "get_collection_data",
    );
    // stack[0] = next_item_index
    itemIndex = (stack.stack[0] as any).readNumber
      ? (stack.stack[0] as any).readNumber()
      : Number((stack.stack[0] as any)[1] ?? 0);
  } catch (e: any) {
    return {
      ...base,
      status: "rejected",
      rejection_reason: `Could not read collection next_item_index: ${e?.message ?? e}`,
    };
  }

  // Step 4: build the mint body
  const collectionAddr = Address.parse(coll.collection_address);
  const collectionFriendly = collectionAddr.toFriendly({
    urlSafe: true,
    bounceable: true,
    testOnly: false,
  });
  const { body, forwardAmount } = buildMintBody({
    itemIndex,
    newOwner: transfer.source,
    // Suffix is appended to common_content (the worker's items base URL).
    // Result: https://worker/items/<collection_friendly>/<index>
    itemContentSuffix: `${collectionFriendly}/${itemIndex}`,
  });

  console.log(
    `[live] prepared mint: collection=${coll.collection_address.slice(0, 12)}…, ` +
      `index=${itemIndex}, recipient=${transfer.source.toFriendly({ urlSafe: true, bounceable: false, testOnly: false }).slice(0, 12)}…, ` +
      `forward=${forwardAmount.toString()} nano`,
  );

  // Step 5: send
  let result: { transferHash: string; seqno: number };
  try {
    result = await sendMint({
      collectionAddress: collectionAddr,
      mintBody: body,
      forwardAmount: forwardAmount.add(toNano("0.05")), // extra for collection contract gas
    });
  } catch (e: any) {
    console.error(`[live] sendMint failed: ${e?.message ?? e}`);
    return {
      ...base,
      status: "rejected",
      rejection_reason: `sendMint failed: ${e?.message ?? e}`,
    };
  }

  console.log(`[live] ✓ mint broadcast tx=${result.transferHash.slice(0, 16)}… seqno=${result.seqno}`);
  return {
    ...base,
    status: "minted",
    mint_tx_hash: result.transferHash,
  };
}

function finalize(summary: RunSummary, startedAt: string): void {
  console.log("─".repeat(60));
  console.log("Run summary:");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Started: ${startedAt}`);
  console.log(`Finished: ${new Date().toISOString()}`);
  console.log("─".repeat(60));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
