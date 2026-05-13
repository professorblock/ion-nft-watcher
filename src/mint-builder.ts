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

  // TIP-64 off-chain content cell: 0x01 byte + URL suffix bytes
  const individualContent = beginCell()
    .storeUint(0x01, 8)
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
