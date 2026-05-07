/**
 * burn-pocket.ts
 * ──────────────
 * Derives the per-collection burn pocket address — a deterministic
 * non-deployable ION address where funds go to be permanently destroyed.
 *
 * The address is computed as `(workchain=0, sha256("ion-nft-burn:" + addr))`.
 * No code corresponds to that hash, so any funds sent there are unrecoverable
 * (recovering would require finding a code+data preimage matching the hash —
 * computationally infeasible for SHA-256).
 *
 * This file is intentionally simple and dependency-light so it can be
 * copy-pasted into the frontend without modification. Both must agree on
 * the exact derivation, otherwise the watcher and frontend would compute
 * different addresses for the same collection.
 */

import { createHash } from "crypto";
import { Address } from "ton";

const BURN_DOMAIN = "ion-nft-burn:v1:";

export function deriveBurnPocket(collectionAddress: Address | string): Address {
  const addr =
    typeof collectionAddress === "string"
      ? Address.parse(collectionAddress)
      : collectionAddress;

  // Canonicalize to a deterministic byte form: workchain (1 byte) + hash (32 bytes).
  // We use the address's hash directly rather than its string form, so different
  // friendly-format flag bits (EQ vs UQ vs 0Q) all produce the same burn pocket.
  const wcByte = Buffer.from([addr.workChain & 0xff]);
  const inner = Buffer.concat([
    Buffer.from(BURN_DOMAIN, "utf8"),
    wcByte,
    addr.hash,
  ]);

  const burnHash = createHash("sha256").update(inner).digest();
  return new Address(0, burnHash);
}
