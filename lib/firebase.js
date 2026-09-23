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
} from "firebase/firestore";

/* =========================================================
   FIREBASE
========================================================= */

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

const ACTIVE_SCANS = "active_scans";

/* =========================================================
   HELPERS
========================================================= */

function normalizeInternalId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

/* =========================================================
   REAL-TIME ACTIVE LIST
========================================================= */

export function subscribeToActiveScans(onData, onError) {
  const activeQuery = query(
    collection(db, ACTIVE_SCANS),
    orderBy("scannedAt", "desc")
  );

  return onSnapshot(
    activeQuery,
    (snapshot) => {
      const scans = snapshot.docs.map((document) => {
        const data = document.data();

        return {
          documentId: document.id,
          internalId: data.internalId || document.id,
          scannedAt:
            data.scannedAt?.toMillis?.() || Date.now(),
          updatedAt:
            data.updatedAt?.toMillis?.() || null,
        };
      });

      onData(scans);
    },
    (error) => {
      console.error("Firestore listener failed:", error);
      onError?.(error);
    }
  );
}

/* =========================================================
   ADD DRAFT IDS TO FIRESTORE

   - Does not overwrite existing IDs.
   - Each ID is protected by a transaction.
   - Existing IDs are returned as skipped.
   - Failed IDs are returned so the UI can keep them locally.
========================================================= */

export async function commitActiveScans(internalIds) {
  const ids = [
    ...new Set(
      internalIds
        .map(normalizeInternalId)
        .filter(Boolean)
    ),
  ];

  const results = await Promise.all(
    ids.map(async (internalId) => {
      const reference = doc(
        db,
        ACTIVE_SCANS,
        internalId
      );

      try {
        const status = await runTransaction(
          db,
          async (transaction) => {
            const existing =
              await transaction.get(reference);

            if (existing.exists()) {
              return "skipped";
            }

            transaction.set(reference, {
              internalId,
              scannedAt: serverTimestamp(),
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
        console.error(
          `Failed to add ${internalId}:`,
          error
        );

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
   UPDATE ACTIVE ID

   Since the ID is also the Firestore document ID,
   renaming requires creating the new document and deleting
   the old one in the same transaction.

   Original scannedAt is preserved.
========================================================= */

export async function updateActiveScan(
  oldInternalId,
  newInternalId
) {
  const oldId = normalizeInternalId(oldInternalId);
  const newId = normalizeInternalId(newInternalId);

  if (!newId) {
    throw new Error("Internal ID is required.");
  }

  if (oldId === newId) {
    return;
  }

  const oldReference = doc(
    db,
    ACTIVE_SCANS,
    oldId
  );

  const newReference = doc(
    db,
    ACTIVE_SCANS,
    newId
  );

  await runTransaction(
    db,
    async (transaction) => {
      const oldDocument =
        await transaction.get(oldReference);

      if (!oldDocument.exists()) {
        throw new Error(
          `${oldId} is no longer active.`
        );
      }

      const newDocument =
        await transaction.get(newReference);

      if (newDocument.exists()) {
        throw new Error(
          `${newId} is already active.`
        );
      }

      const oldData = oldDocument.data();

      transaction.set(newReference, {
        internalId: newId,
        scannedAt:
          oldData.scannedAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      transaction.delete(oldReference);
    }
  );
}

/* =========================================================
   DELETE ONE
========================================================= */

export async function removeActiveScan(internalId) {
  const cleanedId =
    normalizeInternalId(internalId);

  if (!cleanedId) return;

  await deleteDoc(
    doc(
      db,
      ACTIVE_SCANS,
      cleanedId
    )
  );
}

/* =========================================================
   DELETE MULTIPLE

   Uses one atomic Firestore batch rather than Promise.all.
   Either the batch commits or it doesn't.
========================================================= */

export async function removeActiveScans(internalIds) {
  const ids = [
    ...new Set(
      internalIds
        .map(normalizeInternalId)
        .filter(Boolean)
    ),
  ];

  if (ids.length === 0) {
    return;
  }

  const batch = writeBatch(db);

  ids.forEach((internalId) => {
    batch.delete(
      doc(
        db,
        ACTIVE_SCANS,
        internalId
      )
    );
  });

  await batch.commit();
}