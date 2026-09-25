import {
  initializeApp,
  getApps,
} from "firebase/app";

import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  where,
  writeBatch,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey:
    "AIzaSyCC8mn_7bMEkROlnhHtm0hkjMglrkIBxXQ",

  authDomain:
    "locker-site-720a7.firebaseapp.com",

  projectId:
    "locker-site-720a7",

  storageBucket:
    "locker-site-720a7.firebasestorage.app",

  messagingSenderId:
    "138975722760",

  appId:
    "1:138975722760:web:d5f48cb51f6b358efd00bd",
};

const app =
  getApps().length === 0
    ? initializeApp(firebaseConfig)
    : getApps()[0];

export const db =
  getFirestore(app);

const ITEMS_COLLECTION = "items";

export const COMPLETED_PAGE_SIZE = 50;

function normalizeInternalId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function timestampToMillis(value) {
  if (!value) {
    return null;
  }

  if (
    typeof value.toMillis ===
    "function"
  ) {
    return value.toMillis();
  }

  return null;
}

function mapCompletedDocument(
  document
) {
  const data = document.data();

  return {
    documentId:
      document.id,

    internalId:
      data.internalId ||
      document.id,

    status:
      data.status ||
      "completed",

    completionType:
      data.completionType ||
      "signed_out",

    createdAt:
      timestampToMillis(
        data.createdAt
      ),

    completedAt:
      timestampToMillis(
        data.completedAt
      ),

    updatedAt:
      timestampToMillis(
        data.updatedAt
      ),
  };
}

/* =========================================================
   WIP REALTIME LISTENER
========================================================= */

export function subscribeToWip(
  onData,
  onError
) {
  const wipQuery = query(
    collection(
      db,
      ITEMS_COLLECTION
    ),

    where(
      "status",
      "==",
      "wip"
    ),

    orderBy(
      "createdAt",
      "desc"
    )
  );

  return onSnapshot(
    wipQuery,

    (snapshot) => {
      const items =
        snapshot.docs.map(
          (document) => {
            const data =
              document.data();

            return {
              documentId:
                document.id,

              internalId:
                data.internalId ||
                document.id,

              status:
                data.status ||
                "wip",

              createdAt:
                timestampToMillis(
                  data.createdAt
                ) ||
                Date.now(),

              updatedAt:
                timestampToMillis(
                  data.updatedAt
                ),
            };
          }
        );

      onData(items);
    },

    (error) => {
      console.error(
        "WIP listener failed:",
        error
      );

      onError?.(error);
    }
  );
}

/* =========================================================
   COMPLETED - FIRST PAGE

   Not realtime.

   Only reads the newest 50 completed records.
========================================================= */

export async function getCompletedPage(
  lastDocument = null
) {
  const constraints = [
    where(
      "status",
      "==",
      "completed"
    ),

    orderBy(
      "completedAt",
      "desc"
    ),

    orderBy(
      documentId(),
      "desc"
    ),
  ];

  if (lastDocument) {
    constraints.push(
      startAfter(lastDocument)
    );
  }

  constraints.push(
    limit(COMPLETED_PAGE_SIZE)
  );

  const completedQuery =
    query(
      collection(
        db,
        ITEMS_COLLECTION
      ),
      ...constraints
    );

  const snapshot =
    await getDocs(
      completedQuery
    );

  const items =
    snapshot.docs.map(
      mapCompletedDocument
    );

  return {
    items,

    lastDocument:
      snapshot.docs.length
        ? snapshot.docs[
            snapshot.docs.length -
              1
          ]
        : null,

    hasMore:
      snapshot.docs.length ===
      COMPLETED_PAGE_SIZE,
  };
}

/* =========================================================
   COMPLETED - CHECK FOR NEW RECORDS

   Used with the local Completed cache.

   Only asks Firestore for records newer than the newest
   cached completion timestamp.

   We use >= instead of > so records sharing the same
   millisecond are not accidentally missed. The page
   deduplicates by Internal ID.
========================================================= */

export async function getCompletedSince(
  completedAt
) {
  if (!completedAt) {
    return [];
  }

  const completedQuery =
    query(
      collection(
        db,
        ITEMS_COLLECTION
      ),

      where(
        "status",
        "==",
        "completed"
      ),

      where(
        "completedAt",
        ">=",
        new Date(completedAt)
      ),

      orderBy(
        "completedAt",
        "desc"
      )
    );

  const snapshot =
    await getDocs(
      completedQuery
    );

  return snapshot.docs.map(
    mapCompletedDocument
  );
}

/* =========================================================
   COMPLETED - DIRECT ID LOOKUP

   Useful later for search without downloading history.
========================================================= */

export async function getCompletedById(
  internalId
) {
  const id =
    normalizeInternalId(
      internalId
    );

  if (!id) {
    return null;
  }

  const reference =
    doc(
      db,
      ITEMS_COLLECTION,
      id
    );

  const snapshot =
    await getDoc(reference);

  if (!snapshot.exists()) {
    return null;
  }

  const data =
    snapshot.data();

  if (
    data.status !==
    "completed"
  ) {
    return null;
  }

  return mapCompletedDocument(
    snapshot
  );
}

/* =========================================================
   SEND IDS TO WIP
========================================================= */

export async function sendToWip(
  internalIds
) {
  const ids = [
    ...new Set(
      internalIds
        .map(
          normalizeInternalId
        )
        .filter(Boolean)
    ),
  ];

  const results = [];

  const CONCURRENCY = 10;

  for (
    let index = 0;
    index < ids.length;
    index += CONCURRENCY
  ) {
    const chunk =
      ids.slice(
        index,
        index +
          CONCURRENCY
      );

    const chunkResults =
      await Promise.all(
        chunk.map(
          async (
            internalId
          ) => {
            const reference =
              doc(
                db,
                ITEMS_COLLECTION,
                internalId
              );

            try {
              const status =
                await runTransaction(
                  db,

                  async (
                    transaction
                  ) => {
                    const existing =
                      await transaction.get(
                        reference
                      );

                    if (
                      existing.exists()
                    ) {
                      return "skipped";
                    }

                    transaction.set(
                      reference,
                      {
                        internalId,

                        status:
                          "wip",

                        createdAt:
                          serverTimestamp(),

                        updatedAt:
                          serverTimestamp(),
                      }
                    );

                    return "added";
                  }
                );

              return {
                internalId,
                status,
              };
            } catch (
              error
            ) {
              return {
                internalId,

                status:
                  "failed",

                error:
                  error?.message ||
                  "Unknown Firebase error",
              };
            }
          }
        )
      );

    results.push(
      ...chunkResults
    );
  }

  return {
    added: results
      .filter(
        (item) =>
          item.status ===
          "added"
      )
      .map(
        (item) =>
          item.internalId
      ),

    skipped: results
      .filter(
        (item) =>
          item.status ===
          "skipped"
      )
      .map(
        (item) =>
          item.internalId
      ),

    failed: results
      .filter(
        (item) =>
          item.status ===
          "failed"
      )
      .map((item) => ({
        internalId:
          item.internalId,

        error:
          item.error,
      })),
  };
}

/* =========================================================
   REMOVE FROM WIP
========================================================= */

export async function removeWipItem(
  internalId
) {
  const id =
    normalizeInternalId(
      internalId
    );

  if (!id) {
    return;
  }

  await deleteDoc(
    doc(
      db,
      ITEMS_COLLECTION,
      id
    )
  );
}

/* =========================================================
   REMOVE MULTIPLE WIP ITEMS
========================================================= */

export async function removeWipItems(
  internalIds
) {
  const ids = [
    ...new Set(
      internalIds
        .map(
          normalizeInternalId
        )
        .filter(Boolean)
    ),
  ];

  if (
    ids.length === 0
  ) {
    return;
  }

  const BATCH_SIZE = 450;

  for (
    let index = 0;
    index < ids.length;
    index += BATCH_SIZE
  ) {
    const chunk =
      ids.slice(
        index,
        index +
          BATCH_SIZE
      );

    const batch =
      writeBatch(db);

    chunk.forEach(
      (internalId) => {
        batch.delete(
          doc(
            db,
            ITEMS_COLLECTION,
            internalId
          )
        );
      }
    );

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
  const oldId =
    normalizeInternalId(
      oldInternalId
    );

  const newId =
    normalizeInternalId(
      newInternalId
    );

  if (!newId) {
    throw new Error(
      "Internal ID is required."
    );
  }

  if (
    oldId === newId
  ) {
    return;
  }

  const oldReference =
    doc(
      db,
      ITEMS_COLLECTION,
      oldId
    );

  const newReference =
    doc(
      db,
      ITEMS_COLLECTION,
      newId
    );

  await runTransaction(
    db,

    async (
      transaction
    ) => {
      const oldDocument =
        await transaction.get(
          oldReference
        );

      if (
        !oldDocument.exists()
      ) {
        throw new Error(
          `${oldId} is no longer in WIP.`
        );
      }

      const newDocument =
        await transaction.get(
          newReference
        );

      if (
        newDocument.exists()
      ) {
        throw new Error(
          `${newId} already exists.`
        );
      }

      const oldData =
        oldDocument.data();

      transaction.set(
        newReference,
        {
          ...oldData,

          internalId:
            newId,

          status:
            "wip",

          updatedAt:
            serverTimestamp(),
        }
      );

      transaction.delete(
        oldReference
      );
    }
  );
}