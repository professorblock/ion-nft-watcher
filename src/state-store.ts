/**
 * state-store.ts
 * ──────────────
 * Read/write the watcher's persistent state files. State lives in
 * /state/*.json in the repo and is committed back at the end of each
 * cron run, so we have:
 *   - Persistence across runs (GitHub Actions has no other persistence)
 *   - Public auditability (every state change is a git commit)
 *   - Free hosting (the repo is already free)
 *
 * Three state files:
 *   tracked-collections.json   PoB collections we're watching
 *   processed-burns.json       Idempotency log keyed by burn tx hash
 *   last-checked.json          Per-pocket lt cursor for incremental fetches
 */

import * as fs from "fs";
import * as path from "path";

const STATE_DIR = path.join(__dirname, "..", "state");

// ──────────────────────────────────────────────────────────────────
// Tracked collections
// ──────────────────────────────────────────────────────────────────

export interface TrackedCollection {
  /** Collection contract address (EQ form). */
  collection_address: string;
  /** Burn pocket address (EQ form) — derived from collection_address. */
  burn_pocket_address: string;
  /** Creator wallet address (UQ form) — receives creator share of mints. */
  creator_address: string;
  /** Burn percentage (e.g. 80 for 80%). */
  pob_burn_pct: number;
  /** Total mint amount in nano-ION (1 ION = 1e9 nano), as string for BigInt safety. */
  pob_mint_amount_nano: string;
  /** Optional max supply (null = unlimited). */
  max_supply: number | null;
  /** When this collection was registered with the watcher (ISO string). */
  registered_at: string;
}

const TRACKED_FILE = path.join(STATE_DIR, "tracked-collections.json");

export function readTrackedCollections(): TrackedCollection[] {
  if (!fs.existsSync(TRACKED_FILE)) return [];
  try {
    const raw = fs.readFileSync(TRACKED_FILE, "utf8");
    const arr = JSON.parse(raw) as TrackedCollection[];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error(`[state] Failed to read ${TRACKED_FILE}:`, e);
    return [];
  }
}

export function writeTrackedCollections(items: TrackedCollection[]): void {
  ensureStateDir();
  fs.writeFileSync(TRACKED_FILE, JSON.stringify(items, null, 2) + "\n");
}

// ──────────────────────────────────────────────────────────────────
// Processed burns (idempotency log)
// ──────────────────────────────────────────────────────────────────

export interface ProcessedBurn {
  burn_tx_hash: string;
  burn_pocket_address: string;
  burner_address: string;
  amount_nano: string;
  detected_at: string;
  status: "logged" | "validated" | "minted" | "rejected";
  rejection_reason?: string;
  /** Hash of the watcher's mint authorization tx (only set after live signing). */
  mint_tx_hash?: string;
}

const PROCESSED_FILE = path.join(STATE_DIR, "processed-burns.json");

export function readProcessedBurns(): Record<string, ProcessedBurn> {
  if (!fs.existsSync(PROCESSED_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
  } catch (e) {
    console.error(`[state] Failed to read ${PROCESSED_FILE}:`, e);
    return {};
  }
}

export function writeProcessedBurns(burns: Record<string, ProcessedBurn>): void {
  ensureStateDir();
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(burns, null, 2) + "\n");
}

export function isAlreadyProcessed(
  burns: Record<string, ProcessedBurn>,
  burnTxHash: string,
): boolean {
  return Boolean(burns[burnTxHash]);
}

// ──────────────────────────────────────────────────────────────────
// Last-checked cursors (per pocket)
// ──────────────────────────────────────────────────────────────────

export interface LastChecked {
  /** Last logical-time we processed a tx for this pocket. */
  last_lt: string;
  /** Wall-clock time of the last check (informational). */
  last_check: string;
}

const LAST_CHECKED_FILE = path.join(STATE_DIR, "last-checked.json");

export function readLastChecked(): Record<string, LastChecked> {
  if (!fs.existsSync(LAST_CHECKED_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LAST_CHECKED_FILE, "utf8"));
  } catch (e) {
    console.error(`[state] Failed to read ${LAST_CHECKED_FILE}:`, e);
    return {};
  }
}

export function writeLastChecked(cursors: Record<string, LastChecked>): void {
  ensureStateDir();
  fs.writeFileSync(LAST_CHECKED_FILE, JSON.stringify(cursors, null, 2) + "\n");
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function ensureStateDir(): void {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}
