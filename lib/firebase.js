import { initializeApp, getApps } from "firebase/app";

import {
  collection,
  deleteDoc,
  doc,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
  where,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCC8mn_7bMEkROlnhHtm0hkjMglrkIBxXQ",
  authDomain: "locker-site-720a7.firebaseapp.com",
  projectId: "locker-site-720a7",
  storageBucket: "locker-site-720a7.firebasestorage.app",
  messagingSenderId: "138975722760",
  appId: "1:138975722760:web:d5f48cb51f6b358efd00bd",
};

const app =
  getApps().length === 0
    ? initializeApp(firebaseConfig)
    : getApps()[0];

export const db = getFirestore(app);

const ITEMS_COLLECTION = "items";

function normalizeInternalId(value) {
  return String(value || "").trim().toUpperCase();
}

/* =========================================================
   WIP REALTIME LISTENER
========================================================= */

export function subscribeToWip(onData, onError) {
  const wipQuery = query(
    collection(db, ITEMS_COLLECTION),
    where("status", "==", "wip"),
    orderBy("createdAt", "desc")
  );

  return onSnapshot(
    wipQuery,
    (snapshot) => {
      const items = snapshot.docs.map((document) => {
        const data = document.data();

        return {
          documentId: document.id,
          internalId: data.internalId || document.id,
          status: data.status || "wip",
          createdAt: data.createdAt?.toMillis?.() || Date.now(),
          updatedAt: data.updatedAt?.toMillis?.() || null,
        };
      });

      onData(items);
    },
    (error) => {
      console.error("WIP listener failed:", error);
      onError?.(error);
    }
  );
}

/* =========================================================
   SEND IDS TO WIP

   Document ID = internal ID.

   Transaction prevents another user from adding the same
   ID between our check and write.
========================================================= */

export async function sendToWip(internalIds) {
  const ids = [
    ...new Set(
      internalIds.map(normalizeInternalId).filter(Boolean)
    ),
  ];

  const results = [];

  /*
    Deliberately avoid firing an unlimited Promise.all here.

    We process in small groups so a large paste doesn't
    hammer Firestore with hundreds of simultaneous
    transactions.
  */

  const CONCURRENCY = 10;

  for (let index = 0; index < ids.length; index += CONCURRENCY) {
    const chunk = ids.slice(index, index + CONCURRENCY);

    const chunkResults = await Promise.all(
      chunk.map(async (internalId) => {
        const reference = doc(
          db,
          ITEMS_COLLECTION,
          internalId
        );

        try {
          const status = await runTransaction(
            db,
            async (transaction) => {
              const existing = await transaction.get(reference);

              if (existing.exists()) {
                return "skipped";
              }

              transaction.set(reference, {
                internalId,
                status: "wip",
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });

              return "added";
            }
          );

          return {
            internalId,
            status,
          };
        } catch (error) {
          return {
            internalId,
            status: "failed",
            error:
              error?.message ||
              "Unknown Firebase error",
          };
        }
      })
    );

    results.push(...chunkResults);
  }

  return {
    added: results
      .filter((item) => item.status === "added")
      .map((item) => item.internalId),

    skipped: results
      .filter((item) => item.status === "skipped")
      .map((item) => item.internalId),

    failed: results
      .filter((item) => item.status === "failed")
      .map((item) => ({
        internalId: item.internalId,
        error: item.error,
      })),
  };
}

/* =========================================================
   REMOVE FROM WIP
========================================================= */

export async function removeWipItem(internalId) {
  const id = normalizeInternalId(internalId);

  if (!id) return;

  await deleteDoc(
    doc(db, ITEMS_COLLECTION, id)
  );
}

/* =========================================================
   REMOVE MULTIPLE
========================================================= */

export async function removeWipItems(internalIds) {
  const ids = [
    ...new Set(
      internalIds.map(normalizeInternalId).filter(Boolean)
    ),
  ];

  if (ids.length === 0) return;

  /*
    Firestore batches support up to 500 writes.
    Chunking keeps this safe for larger WIP lists.
  */

  const BATCH_SIZE = 450;

  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const chunk = ids.slice(index, index + BATCH_SIZE);

    const batch = writeBatch(db);

    chunk.forEach((internalId) => {
      batch.delete(
        doc(db, ITEMS_COLLECTION, internalId)
      );
    });

    await batch.commit();
  }
}

/* =========================================================
   RENAME WIP ID
========================================================= */

export async function updateWipItem(
  oldInternalId,
  newInternalId
) {
  const oldId = normalizeInternalId(oldInternalId);
  const newId = normalizeInternalId(newInternalId);

  if (!newId) {
    throw new Error("Internal ID is required.");
  }

  if (oldId === newId) return;

  const oldReference = doc(
    db,
    ITEMS_COLLECTION,
    oldId
  );

  const newReference = doc(
    db,
    ITEMS_COLLECTION,
    newId
  );

  await runTransaction(db, async (transaction) => {
    const oldDocument = await transaction.get(oldReference);

    if (!oldDocument.exists()) {
      throw new Error(`${oldId} is no longer in WIP.`);
    }

    const newDocument = await transaction.get(newReference);

    if (newDocument.exists()) {
      throw new Error(`${newId} already exists.`);
    }

    const oldData = oldDocument.data();

    transaction.set(newReference, {
      ...oldData,
      internalId: newId,
      status: "wip",
      updatedAt: serverTimestamp(),
    });

    transaction.delete(oldReference);
  });
}