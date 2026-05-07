/**
 * ion-rpc.ts
 * ──────────
 * Thin wrapper around the `ton@12` TonClient for the watcher's read needs.
 * No state, no signing — just incoming-transaction fetches against ION's
 * HTTP API.
 */

import BN from "bn.js";
import { Address, TonClient } from "ton";
import { ION_RPC_ENDPOINT } from "./ion-config";

let _client: TonClient | null = null;

export function getClient(): TonClient {
  if (!_client) {
    _client = new TonClient({ endpoint: ION_RPC_ENDPOINT });
  }
  return _client;
}

/**
 * One incoming transfer to a watched address.
 * Stripped down to the fields the watcher actually uses.
 */
export interface IncomingTransfer {
  /** Tx hash on the recipient (burn-pocket) side. Idempotency key. */
  tx_hash: string;
  /** Logical time of the recipient-side tx. */
  lt: string;
  /** Wall-clock seconds. */
  utime: number;
  /** Sender wallet address. */
  source: Address;
  /** Recipient (the burn pocket itself). */
  destination: Address;
  /** Amount in nano-ION as BN. */
  value_nano: BN;
  /** Optional comment / payload. */
  body_text?: string;
}

/**
 * Fetch incoming transfers to `address` since `sinceLt` (exclusive).
 * Returns oldest-first so callers can process in order and update cursor cleanly.
 */
export async function fetchIncomingSince(
  address: Address,
  sinceLt: string | null,
  limit: number,
): Promise<IncomingTransfer[]> {
  const client = getClient();

  // ton@12 returns transactions newest-first; we'll reverse for oldest-first.
  const txs = await client.getTransactions(address, {
    limit,
    // No `lt`/`hash` cursor on ton@12's getTransactions; we filter in memory.
  });

  const sinceLtBN = sinceLt ? new BN(sinceLt) : new BN(0);
  const results: IncomingTransfer[] = [];

  for (const tx of txs) {
    const txLt = new BN(tx.id.lt);
    if (sinceLt && txLt.lte(sinceLtBN)) continue;

    const inMsg = tx.inMessage;
    if (!inMsg) continue;

    // Only care about incoming value transfers from external wallets.
    // (Skip messages with no source — those are external user-signed tx,
    // which doesn't apply to a non-deployable burn pocket anyway.)
    const source = inMsg.source;
    if (!source) continue;

    const value = inMsg.value;
    if (!value || value.isZero()) continue;

    let bodyText: string | undefined;
    try {
      // ton@12 message bodies expose .text for comment-style payloads.
      const anyMsg = inMsg as any;
      if (typeof anyMsg.body?.text === "string") {
        bodyText = anyMsg.body.text;
      }
    } catch {
      /* non-text body, ignore */
    }

    results.push({
      tx_hash: tx.id.hash,
      lt: tx.id.lt,
      utime: tx.time,
      source,
      destination: address,
      value_nano: value,
      body_text: bodyText,
    });
  }

  // Oldest first
  return results.reverse();
}

/**
 * Confirm an account exists on-chain (used to validate the platform mint key
 * wallet has been deployed and funded before live mode tries to use it).
 */
export async function isAccountActive(address: Address): Promise<boolean> {
  try {
    return await getClient().isContractDeployed(address);
  } catch {
    return false;
  }
}
