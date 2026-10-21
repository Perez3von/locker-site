// Offline submissions are durable only after IndexedDB commits successfully.
// This module is client-only; never import it from server components.
import { sendToWip } from "./firebase";

const DATABASE = "locker-offline-v1";
const VERSION = 1;
export const QUEUE_CHANGED = "locker:queue-changed";
export const SYNC_CHANGED = "locker:sync-changed";
const LAST_SYNC_KEY = "locker-last-sync-v1";
const INTERNAL_ID_RE = /^[A-Z0-9_-]{1,128}$/;
let dbPromise;
let syncInProgress = false;

function normalizeId(value) {
  return String(value ?? "").trim().toUpperCase();
}

function indexedDBAvailable() {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDatabase() {
  if (!indexedDBAvailable()) return Promise.reject(new Error("Offline storage is unavailable in this browser."));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "internalId" });
        if (!db.objectStoreNames.contains("drafts")) db.createObjectStore("drafts", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open offline storage."));
      request.onblocked = () => reject(new Error("Close other Locker tabs and retry."));
    }).catch((error) => { dbPromise = undefined; throw error; });
  }
  return dbPromise;
}

function completeTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Device storage operation failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Device storage operation was cancelled."));
  });
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Device storage read failed."));
  });
}

export function notifyQueueChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(QUEUE_CHANGED));
}

// Draft backup in IndexedDB. The immediate localStorage mirror in Collect
// keeps the newest user edit safe even before an async IndexedDB write finishes.
export async function readStoredDraft() {
  const db = await openDatabase();
  return requestValue(db.transaction("drafts", "readonly").objectStore("drafts").get("collect"));
}

export async function writeStoredDraft(ids) {
  const db = await openDatabase();
  const tx = db.transaction("drafts", "readwrite");
  tx.objectStore("drafts").put({ id: "collect", ids: [...new Set(ids.map(normalizeId).filter(Boolean))], savedAt: Date.now() });
  await completeTransaction(tx);
}

export async function pendingEntries() {
  const db = await openDatabase();
  return requestValue(db.transaction("pending", "readonly").objectStore("pending").getAll());
}

export async function pendingCount() {
  const db = await openDatabase();
  return requestValue(db.transaction("pending", "readonly").objectStore("pending").count());
}

export async function queueWip(ids, signatureName) {
  const name = String(signatureName ?? "").trim();
  if (!name || name.length > 250) throw new Error("Enter a Signed By name (1–250 characters).");
  const normalized = [...new Set((Array.isArray(ids) ? ids : []).map(normalizeId).filter(Boolean))];
  const invalid = normalized.filter((id) => !INTERNAL_ID_RE.test(id));
  if (invalid.length) throw new Error(`Invalid Internal ID: ${invalid[0]}. Use 1–128 letters, numbers, _ or -.`);
  if (!normalized.length) return { queued: [], alreadyQueued: [] };

  const db = await openDatabase();
  // Read and write in ONE transaction so accidental double submissions don't
  // overwrite the Signed By value of a previously queued job.
  const tx = db.transaction("pending", "readwrite");
  const store = tx.objectStore("pending");
  const queued = [];
  const alreadyQueued = [];
  for (const internalId of normalized) {
    const existing = await requestValue(store.get(internalId));
    if (existing) {
      alreadyQueued.push(internalId);
    } else {
      store.add({ internalId, signatureName: name, queuedAt: Date.now(), lastError: "" });
      queued.push(internalId);
    }
  }
  await completeTransaction(tx);
  // Let Collect persist its remaining draft before prompting an online sync.
  return { queued, alreadyQueued };
}

async function removePending(ids) {
  if (!ids.length) return;
  const db = await openDatabase();
  const tx = db.transaction("pending", "readwrite");
  for (const id of ids) tx.objectStore("pending").delete(id);
  await completeTransaction(tx);
  notifyQueueChanged();
}

function publishSummary(summary) {
  const event = { ...summary, at: Date.now() };
  try { localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(event)); } catch { /* optional UI notification */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SYNC_CHANGED, { detail: event }));
}

export function lastSyncSummary() {
  try { return JSON.parse(localStorage.getItem(LAST_SYNC_KEY) || "null"); } catch { return null; }
}

async function doSync() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const entries = await pendingEntries();
  if (!entries.length) return;
  let added = 0;
  let skipped = 0;
  let failed = 0;
  let latestError = "";

  // Each entry preserves its original Signed By. Grouping by name is safe,
  // but processing sequentially is easier to recover after interruption.
  for (const entry of entries) {
    if (typeof navigator !== "undefined" && navigator.onLine === false) break;
    try {
      const result = await sendToWip([entry.internalId], entry.signatureName);
      if (result.added.includes(entry.internalId) || result.skipped.includes(entry.internalId)) {
        await removePending([entry.internalId]); // Remove ONLY after server confirmation.
        if (result.added.includes(entry.internalId)) added += 1;
        else skipped += 1;
      } else {
        failed += 1;
        latestError = result.failed[0]?.error || "Server did not confirm this ID.";
        if (/offline|network|unavailable|timeout|failed to fetch/i.test(latestError)) break;
      }
    } catch (error) {
      failed += 1;
      latestError = error?.message || "Could not reach Firestore.";
      break;
    }
  }
  publishSummary({ added, skipped, failed, error: latestError });
}

export async function syncPending() {
  if (syncInProgress || typeof window === "undefined") return;
  syncInProgress = true;
  try {
    // Browser tab lock prevents duplicate work across open tabs. Firestore
    // transactions still provide idempotency where Web Locks is unavailable.
    if (navigator.locks?.request) {
      await navigator.locks.request("locker-wip-sync-v1", { ifAvailable: true }, async (lock) => {
        if (lock) await doSync();
      });
    } else {
      await doSync();
    }
  } finally {
    syncInProgress = false;
  }
}
