// Employee-side Firebase client: reading WIP and creating new WIP submissions only.
// Authorization is enforced by firestore.rules, NOT by the exported functions here.
import { getApps, initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "firebase/firestore";

// Firebase's web configuration is public client configuration, not a service-account key.
const firebaseConfig = {
  apiKey: "AIzaSyCC8mn_7bMEkROlnhHtm0hkjMglrkIBxXQ",
  authDomain: "locker-site-720a7.firebaseapp.com",
  projectId: "locker-site-720a7",
  storageBucket: "locker-site-720a7.firebasestorage.app",
  messagingSenderId: "138975722760",
  appId: "1:138975722760:web:d5f48cb51f6b358efd00bd",
};

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
export const db = getFirestore(app);
const ITEMS = "items";
const RECENT_WIP_LIMIT = 100;

function normalizeInternalId(value) {
  return String(value ?? "").trim().toUpperCase();
}

function timeMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

// Collect needs to know about recently collected IDs for immediate duplicate UX.
// This listener intentionally reads only the newest 100 WIP entries, not the entire DB.
// The Firestore transaction in sendToWip enforces duplicate prevention for ALL IDs.
export function subscribeToWip(onData, onError) {
  const wipQuery = query(
    collection(db, ITEMS),
    where("status", "==", "wip"),
    orderBy("createdAt", "desc"),
    limit(RECENT_WIP_LIMIT)
  );

  return onSnapshot(wipQuery, (snapshot) => {
    onData(snapshot.docs.map((entry) => {
      const data = entry.data();
      return {
        documentId: entry.id,
        internalId: data.internalId || entry.id,
        signatureName: data.signatureName || "RETAG",
        status: "wip",
        createdAt: timeMillis(data.createdAt) ?? Date.now(),
        updatedAt: timeMillis(data.updatedAt),
      };
    }));
  }, (error) => {
    console.error("WIP listener failed:", error);
    onError?.(error);
  });
}

export async function sendToWip(internalIds, signatureName = "RETAG") {
  const assignedName = String(signatureName ?? "").trim();
  if (!assignedName || assignedName.length > 250) {
    throw new Error("Signed By must contain 1–250 characters.");
  }
  const ids = [...new Set((Array.isArray(internalIds) ? internalIds : [])
    .map(normalizeInternalId)
    .filter(Boolean))];

  const results = [];
  const CONCURRENCY = 10;
  for (let index = 0; index < ids.length; index += CONCURRENCY) {
    const chunk = ids.slice(index, index + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(async (internalId) => {
      if (!/^[A-Z0-9_-]{1,128}$/.test(internalId)) {
        return { internalId, status: "failed", error: "Internal IDs must contain 1–128 letters, numbers, underscores, or hyphens." };
      }
      const reference = doc(db, ITEMS, internalId);
      try {
        const status = await runTransaction(db, async (transaction) => {
          const existing = await transaction.get(reference);
          if (existing.exists()) return "skipped";
          transaction.set(reference, {
            internalId,
            signatureName: assignedName,
            status: "wip",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          return "added";
        });
        return { internalId, status };
      } catch (error) {
        return { internalId, status: "failed", error: error?.message || "Could not save to Firestore." };
      }
    }));
    results.push(...chunkResults);
  }

  return {
    added: results.filter((result) => result.status === "added").map((result) => result.internalId),
    skipped: results.filter((result) => result.status === "skipped").map((result) => result.internalId),
    failed: results.filter((result) => result.status === "failed").map(({ internalId, error }) => ({ internalId, error })),
  };
}
