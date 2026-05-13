/**
 * source-tx-verify.ts
 * ───────────────────
 * Given a burn detected at a burn pocket, fetch the burner's source
 * transaction (the one that originated the 3-message split) and verify
 * that all three legs (burn, creator, treasury) match the expected
 * proportions for the registered collection.
 *
 * If any leg is missing, the amounts don't add up, or destinations don't
 * match, we refuse to authorize the mint.
 */

import BN from "bn.js";
import { Address } from "ton";
import { getClient } from "./ion-rpc";
import { POB_PLATFORM_FEE_BPS } from "./ion-config";

export interface SourceTxVerificationOk {
  ok: true;
  burner: Address;
  collectionAddress: string;
}

export interface SourceTxVerificationFailed {
  ok: false;
  reason: string;
}

export type SourceTxVerification = SourceTxVerificationOk | SourceTxVerificationFailed;

interface ExpectedSplits {
  burnPocket: Address;
  burnNano: BN;
  creator: Address;
  creatorNano: BN;
  treasury: Address;
  treasuryNano: BN;
}

/**
 * Find the burner's transaction that produced this incoming burn message,
 * then verify all 3 split legs are present with correct amounts.
 *
 * Tolerance: we allow each leg to be ≥ the expected amount (in case the
 * frontend rounded up slightly). We don't allow < expected — that would
 * mean someone is shortchanging the splits.
 */
export async function verifyBurnSplits(
  burner: Address,
  burnPocketTxLt: string,
  expected: ExpectedSplits,
): Promise<SourceTxVerification> {
  const client = getClient();

  // Fetch recent transactions from the burner's wallet. The source tx for our
  // burn pocket message will be among them — we identify it by checking each
  // tx's out-messages for one with destination = burn pocket and value = burn
  // amount.
  let txs;
  try {
    txs = await client.getTransactions(burner, { limit: 20 });
  } catch (e: any) {
    return {
      ok: false,
      reason: `Could not fetch burner's transactions: ${e?.message ?? e}`,
    };
  }

  const burnPocketKey = expected.burnPocket.toFriendly({
    urlSafe: true,
    bounceable: false,
    testOnly: false,
  });

  // Find the tx whose outMessages include our burn pocket destination.
  let sourceTx = null;
  for (const tx of txs) {
    const out = (tx.outMessages ?? []) as any[];
    const match = out.find((m) => {
      const dest = m?.destination ?? m?.info?.dest ?? null;
      if (!dest) return false;
      try {
        const destStr = (dest as Address).toFriendly({
          urlSafe: true,
          bounceable: false,
          testOnly: false,
        });
        return destStr === burnPocketKey;
      } catch {
        return false;
      }
    });
    if (match) {
      sourceTx = tx;
      break;
    }
  }

  if (!sourceTx) {
    return {
      ok: false,
      reason:
        "Could not find the burner's source transaction containing this burn message. " +
        "Either the chain hasn't indexed it yet, or the burner constructed the message " +
        "outside the normal wallet flow.",
    };
  }

  const out = (sourceTx.outMessages ?? []) as any[];
  if (out.length < 3) {
    return {
      ok: false,
      reason: `Source tx has only ${out.length} outgoing message(s); expected 3 (burn + creator + treasury)`,
    };
  }

  // Verify each leg
  const findLegByDest = (target: Address) => {
    const targetKey = target.toFriendly({ urlSafe: true, bounceable: false, testOnly: false });
    return out.find((m) => {
      const dest = m?.destination ?? m?.info?.dest ?? null;
      if (!dest) return false;
      try {
        const ds = (dest as Address).toFriendly({
          urlSafe: true,
          bounceable: false,
          testOnly: false,
        });
        return ds === targetKey;
      } catch {
        return false;
      }
    });
  };

  const burnLeg = findLegByDest(expected.burnPocket);
  const creatorLeg = findLegByDest(expected.creator);
  const treasuryLeg = findLegByDest(expected.treasury);

  if (!burnLeg) return { ok: false, reason: "Burn leg not found in source tx" };
  if (!creatorLeg) return { ok: false, reason: "Creator leg not found in source tx" };
  if (!treasuryLeg) return { ok: false, reason: "Treasury leg not found in source tx" };

  const getValue = (msg: any): BN => {
    const v = msg?.value ?? msg?.info?.value?.coins;
    return BN.isBN(v) ? v : new BN(v?.toString() ?? "0");
  };

  if (getValue(burnLeg).lt(expected.burnNano)) {
    return {
      ok: false,
      reason: `Burn leg insufficient: got ${getValue(burnLeg).toString()} nano, expected ≥ ${expected.burnNano.toString()}`,
    };
  }
  if (getValue(creatorLeg).lt(expected.creatorNano)) {
    return {
      ok: false,
      reason: `Creator leg insufficient: got ${getValue(creatorLeg).toString()} nano, expected ≥ ${expected.creatorNano.toString()}`,
    };
  }
  if (getValue(treasuryLeg).lt(expected.treasuryNano)) {
    return {
      ok: false,
      reason: `Treasury leg insufficient: got ${getValue(treasuryLeg).toString()} nano, expected ≥ ${expected.treasuryNano.toString()}`,
    };
  }

  return {
    ok: true,
    burner,
    collectionAddress: expected.burnPocket.toFriendly({
      urlSafe: true,
      bounceable: true,
      testOnly: false,
    }),
  };
}

/**
 * Helper: compute expected split amounts from collection metadata.
 * Mirrors the frontend's PobMintFlow computation.
 */
export function computeExpectedSplits(
  totalMintAmountNano: BN,
  burnPct: number,
): { burnNano: BN; creatorNano: BN; treasuryNano: BN } {
  const burnNano = totalMintAmountNano.muln(burnPct).divn(100);
  const treasuryNano = totalMintAmountNano.muln(POB_PLATFORM_FEE_BPS).divn(10_000);
  const creatorNano = totalMintAmountNano.sub(burnNano).sub(treasuryNano);
  return { burnNano, creatorNano, treasuryNano };
}
