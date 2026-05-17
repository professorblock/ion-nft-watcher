/**
 * mint-builder.ts
 * ───────────────
 * Builds the mint message body cell for getgems-io/nft-contracts'
 * nft-collection-editable-v2 contract.
 *
 * Expected body layout (op = 1):
 *   op (32 bits, = 1)
 *   query_id (64 bits)
 *   item_index (64 bits)
 *   amount (Coins) — ION forwarded to the new NFT item for its initial balance + gas
 *   nft_content (ref) — the cell that becomes the NFT item's content init:
 *     owner_address (MsgAddress)
 *     individual_content (ref to TIP-64 off-chain content cell)
 */

import BN from "bn.js";
import { Address, Cell, beginCell, toNano } from "ton";

/**
 * Build the body cell for a mint op.
 */
export function buildMintBody(args: {
  itemIndex: number;
  newOwner: Address;
  /** URL suffix appended to the collection's common_content (usually the item index). */
  itemContentSuffix: string;
  /** ION forwarded to the new NFT item contract. 0.05 ION is typical. */
  forwardAmount?: BN;
}): { body: Cell; forwardAmount: BN } {
  const forwardAmount = args.forwardAmount ?? toNano("0.05");

  // For PoB v1, every minted NFT in a collection shares the same metadata
  // (same image, same name as the collection cover). To achieve this, the
  // watcher passes an EMPTY suffix so the contract resolves NFT content to
  // just the collection's common_content URI — the metadata JSON the wizard
  // pinned during deploy. If we want per-item metadata in v2, we'd: (1) host
  // a server route that returns item-specific JSON, and (2) pass a suffix
  // like `${itemIndex}.json`.

  // TIP-64 individual_content cell: per the standard NFT collection FunC
  // contract, get_nft_content() prepends 0x01 + common_content + individual_content.
  // So individual_content must be JUST the suffix bytes — NO 0x01 prefix here,
  // or we end up with `0x01<common_url>0x01<suffix>` (a malformed URL with
  // a control byte mid-path).
  const individualContent = beginCell()
    .storeBuffer(Buffer.from(args.itemContentSuffix, "utf-8"))
    .endCell();

  // The cell that becomes the new NFT item's data (after collection prepends
  // item_index and collection_address): owner address + ref to content.
  const nftContent = beginCell()
    .storeAddress(args.newOwner)
    .storeRef(individualContent)
    .endCell();

  const body = beginCell()
    .storeUint(1, 32) // op = mint
    .storeUint(BigInt(Date.now()) % 0xffffffffffffffffn as unknown as number, 64) // query_id
    .storeUint(args.itemIndex, 64)
    .storeCoins(forwardAmount)
    .storeRef(nftContent)
    .endCell();

  return { body, forwardAmount };
}
