/**
 * ion-config.ts
 * ─────────────
 * Network endpoints, platform addresses, and monetization constants.
 * Mirrors values from the frontend (ion-nft-studio) so the watcher
 * uses the same RPC, treasury, and split rules.
 */

import { Address } from "ton";

// Same RPC the Hub Jetton minter and NFT Studio frontend use.
export const ION_RPC_ENDPOINT = "https://api.mainnet.ice.io/http/v2/jsonRPC";

// Platform treasury — receives the platform's slice of every PoB mint.
// This is the COLD wallet address (not the watcher's hot mint key).
// Set via env so we never hardcode without explicit choice.
export const PLATFORM_TREASURY_ADDRESS_STR =
  process.env.PLATFORM_TREASURY_ADDRESS ?? "";

// Watcher's hot mint key — owns every PoB collection on-chain.
// The corresponding seed phrase lives in MINT_KEY_MNEMONIC env var
// (set as a GitHub Actions secret). Never hardcoded.
export const PLATFORM_MINT_KEY_ADDRESS_STR =
  process.env.PLATFORM_MINT_KEY_ADDRESS ?? "";

// ──────────────────────────────────────────────────────────────────
// Split rules — mirror the wizard's defaults in nft-deploy-controller.ts
// ──────────────────────────────────────────────────────────────────

/** Minimum % of each PoB mint that must be burned. 50% floor. */
export const POB_MIN_BURN_BPS = 5_000; // basis points; 10000 = 100%

/** Platform's slice of each PoB mint, taken from the non-burned portion. */
export const POB_PLATFORM_FEE_BPS = 200; // 2.00%

/** Minimum mint amount per PoB mint (anti-dust). */
export const POB_MIN_MINT_AMOUNT_NANO = BigInt(1_000_000_000_000); // 1000 ION

// ──────────────────────────────────────────────────────────────────
// Watcher operational config
// ──────────────────────────────────────────────────────────────────

/** Max burns processed per cron run. Caps Actions runtime, prevents flooding. */
export const MAX_BURNS_PER_RUN = 50;

/** Max txs to fetch per pocket per run. */
export const MAX_TXS_PER_POCKET_PER_RUN = 100;

/** Watcher run mode. "log" = read-only (default). "live" = sign mints. */
export type WatcherMode = "log" | "live";
export const WATCHER_MODE: WatcherMode =
  (process.env.WATCHER_MODE as WatcherMode) === "live" ? "live" : "log";

export function getTreasuryAddress(): Address | null {
  if (!PLATFORM_TREASURY_ADDRESS_STR) return null;
  try {
    return Address.parse(PLATFORM_TREASURY_ADDRESS_STR);
  } catch {
    return null;
  }
}

export function getMintKeyAddress(): Address | null {
  if (!PLATFORM_MINT_KEY_ADDRESS_STR) return null;
  try {
    return Address.parse(PLATFORM_MINT_KEY_ADDRESS_STR);
  } catch {
    return null;
  }
}
