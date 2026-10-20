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
  getDocsFromServer,
  getCountFromServer,
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

    signatureName:
      data.signatureName ||
      null,

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
   COMPLETED — BOUNDED SERVER PAGINATION + FILTERS

   Each page reads at most 51 documents (50 visible + 1 to
   determine whether Next is available). Never scan/cache
   the entire collection on page load.
========================================================= */

const COMPLETED_DELETE_CHUNK = 40;
const COMPLETED_DELETE_LIMIT = 2000;

function completedFilters(filters = {}) {
  const startDate = String(filters.startDate || "").trim();
  const endDate = String(filters.endDate || "").trim();
  const completionType = String(filters.completionType || "").trim();
  const signatureName = String(filters.signatureName || "").trim();

  function localBoundary(value, addDay = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error("Select valid dates.");
    }
    const [year, month, day] = value.split("-").map(Number);
    const result = new Date(year, month - 1, day + Number(addDay));
    if (
      Number.isNaN(result.getTime()) ||
      (!addDay && (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day))
    ) {
      throw new Error("Select valid dates.");
    }
    return result;
  }

  const start = startDate ? localBoundary(startDate) : null;
  const endExclusive = endDate ? localBoundary(endDate, true) : null;
  if (start && endExclusive && start >= endExclusive) {
    throw new Error("The end date must be on or after the start date.");
  }
  if (completionType && !["signed_out", "already_signed_out", "manually_verified"].includes(completionType)) {
    throw new Error("Unknown completion reason.");
  }
  if (signatureName.length > 250) {
    throw new Error("Signed By filter is too long.");
  }

  return { startDate, endDate, completionType, signatureName, start, endExclusive };
}

function completedQueryConstraints(filters) {
  const f = completedFilters(filters);
  const constraints = [where("status", "==", "completed")];
  if (f.completionType) constraints.push(where("completionType", "==", f.completionType));
  if (f.signatureName) constraints.push(where("signatureName", "==", f.signatureName));
  if (f.start) constraints.push(where("completedAt", ">=", f.start));
  if (f.endExclusive) constraints.push(where("completedAt", "<", f.endExclusive));
  constraints.push(orderBy("completedAt", "desc"));
  constraints.push(orderBy(documentId(), "desc"));
  return constraints;
}

function completedQuery(filters, extra = []) {
  return query(
    collection(db, ITEMS_COLLECTION),
    ...completedQueryConstraints(filters),
    ...extra
  );
}

export async function getCompletedPage(cursor = null, filters = {}) {
  const extras = cursor ? [startAfter(cursor)] : [];
  const snapshot = await getDocsFromServer(
    completedQuery(filters, [...extras, limit(COMPLETED_PAGE_SIZE + 1)])
  );
  const visible = snapshot.docs.slice(0, COMPLETED_PAGE_SIZE);
  return {
    items: visible.map(mapCompletedDocument),
    lastDocument: visible.at(-1) || null,
    hasMore: snapshot.docs.length > COMPLETED_PAGE_SIZE,
  };
}

export async function getCompletedCount(filters = {}) {
  const snapshot = await getCountFromServer(completedQuery(filters));
  return snapshot.data().count;
}

function matchesCompletedDocument(data, filters = {}) {
  const f = completedFilters(filters);
  if (!data || data.status !== "completed") return false;
  if (f.completionType && data.completionType !== f.completionType) return false;
  if (f.signatureName && data.signatureName !== f.signatureName) return false;
  const date = data.completedAt && typeof data.completedAt.toDate === "function"
    ? data.completedAt.toDate()
    : null;
  if (!date) return false;
  if (f.start && date < f.start) return false;
  if (f.endExclusive && date >= f.endExclusive) return false;
  return true;
}

async function deleteCompletedBatch(ids, filters = {}) {
  const normalized = [...new Set(ids.map(normalizeInternalId).filter(Boolean))];
  if (!normalized.length) return 0;
  if (normalized.length > COMPLETED_DELETE_CHUNK) {
    throw new Error("Too many records in one delete batch.");
  }
  const references = normalized.map(id => doc(db, ITEMS_COLLECTION, id));
  return runTransaction(db, async transaction => {
    // Firestore transactions must read every document before any writes.
    const snapshots = [];
    for (const reference of references) snapshots.push(await transaction.get(reference));
    let deleted = 0;
    for (let index = 0; index < snapshots.length; index++) {
      const snapshot = snapshots[index];
      if (!snapshot.exists() || !matchesCompletedDocument(snapshot.data(), filters)) continue;
      transaction.delete(references[index]);
      deleted++;
    }
    return deleted;
  });
}

// Only selected, visible IDs are deleted; reverify against Firestore in the transaction.
export async function deleteCompletedSelected(ids, filters = {}) {
  const normalized = [...new Set(ids.map(normalizeInternalId).filter(Boolean))];
  if (normalized.length > COMPLETED_PAGE_SIZE) {
    throw new Error("Select at most 50 records at once.");
  }
  let deleted = 0;
  for (let index = 0; index < normalized.length; index += COMPLETED_DELETE_CHUNK) {
    deleted += await deleteCompletedBatch(normalized.slice(index, index + COMPLETED_DELETE_CHUNK), filters);
  }
  return deleted;
}

// Permanently delete historical completed records matching an end-date-bounded filter.
// The query always starts from the first matching record because each batch removes it.
// This deliberately performs reads DURING a requested deletion, never on initial page load.
export async function deleteCompletedMatching(filters, onProgress = () => {}) {
  const f = completedFilters(filters);
  if (!f.endDate) {
    throw new Error("Choose an end date before deleting all matching history.");
  }
  let deleted = 0;
  while (deleted < COMPLETED_DELETE_LIMIT) {
    const remaining = Math.min(COMPLETED_DELETE_CHUNK, COMPLETED_DELETE_LIMIT - deleted);
    const snapshot = await getDocsFromServer(completedQuery(filters, [limit(remaining)]));
    if (snapshot.empty) break;
    const count = await deleteCompletedBatch(snapshot.docs.map(item => item.id), filters);
    if (!count) throw new Error("Records changed while deleting. Refresh and try again.");
    deleted += count;
    onProgress(deleted);
  }
  return { deleted, reachedSafetyLimit: deleted === COMPLETED_DELETE_LIMIT };
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
  internalIds,
  signatureName = "RETAG"
) {
  const assignedName = String(signatureName ?? "").trim();
  if (!assignedName || assignedName.length > 250) {
    throw new Error("Signed By must contain 1–250 characters.");
  }
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

                        signatureName: assignedName,

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

/* =========================================================
   CORRECT THE SIGNED BY NAME ON A WIP ITEM
   Refuse edits once the worker has claimed the item.
========================================================= */
export async function updateWipSignatureName(internalId, signatureName) {
  const id = normalizeInternalId(internalId);
  const name = String(signatureName ?? "").trim();
  if (!id) throw new Error("Internal ID is required.");
  if (!name || name.length > 250) throw new Error("Signed By must contain 1–250 characters.");
  const reference = doc(db, ITEMS_COLLECTION, id);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists() || snapshot.data().status !== "wip") {
      throw new Error("This item is no longer in WIP.");
    }
    if (["queued", "processing", "review"].includes(snapshot.data().automationStatus)) {
      throw new Error("This item's sign-out is locked. Its Signed By name cannot be changed now.");
    }
    transaction.update(reference, {
      signatureName: name,
      updatedAt: serverTimestamp(),
    });
  });
}


/* =========================================================
   WIP QUEUE CONTROL — TRANSACTIONALLY GUARDED
   A queued job can be canceled up until the worker claims it.
   Existing .automation-queue files are safely ignored by the
   worker because its jobId claim check will fail.
========================================================= */
export async function cancelQueuedWipJob(internalId) {
  const id = normalizeInternalId(internalId);
  if (!id) throw new Error("Internal ID is required.");
  const reference = doc(db, ITEMS_COLLECTION, id);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists() || snapshot.data().status !== "wip") {
      throw new Error("Item is no longer in WIP.");
    }
    const data = snapshot.data();
    if (data.automationStatus !== "queued") {
      throw new Error("This job has already started or changed status; it cannot be canceled.");
    }
    const members = data.automationMethod === "batch" && Array.isArray(data.automationBatchIds)
      ? [...new Set(data.automationBatchIds.map(normalizeInternalId))] : [id];
    if (!members.includes(id) || members.length < 1 || members.length > 30) {
      throw new Error("Invalid batch metadata. Cannot cancel safely.");
    }
    const refs = members.map(member => doc(db, ITEMS_COLLECTION, member));
    // Firestore requires all transaction reads before writes.
    const snapshots = await Promise.all(refs.map(ref => transaction.get(ref)));
    for (let i = 0; i < snapshots.length; i++) {
      if (!snapshots[i].exists() || snapshots[i].data().status !== "wip" ||
        snapshots[i].data().automationStatus !== "queued" ||
        snapshots[i].data().automationJobId !== data.automationJobId) {
        throw new Error("Part of this batch has already started or changed. No members were canceled.");
      }
    }
    for (const ref of refs) {
      transaction.update(ref, {
        automationStatus: "ready",
        automationJobId: null,
        automationMethod: null,
        automationBatchIds: null,
        automationError: null,
        lastCanceledJobId: data.automationJobId || null,
        automationUpdatedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return { canceled: members };
  });
}

/* =========================================================
   REVIEW RESOLUTION — ONLY AFTER USER VERIFIED IN MSPT
   Never auto-retry an uncertain Save. The user must enter
   the exact Internal ID and confirm that MSPT shows NO signout.
========================================================= */
export async function releaseReviewedWipItem(internalId, typedId, verifiedNotSignedOut) {
  const id = normalizeInternalId(internalId);
  if (!id || normalizeInternalId(typedId) !== id || verifiedNotSignedOut !== true) {
    throw new Error("Verify MSPT, check the confirmation, and enter the exact Internal ID.");
  }
  const reference = doc(db, ITEMS_COLLECTION, id);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists() || snapshot.data().status !== "wip") {
      throw new Error("Item is no longer in WIP.");
    }
    const data = snapshot.data();
    if (data.automationStatus !== "review") {
      throw new Error("Item is no longer awaiting review. Refresh before proceeding.");
    }
    // Preserve original error and job id for audit/recovery.
    transaction.update(reference, {
      automationStatus: "ready",
      automationStage: "Returned to Waiting after MSPT verification",
      automationJobId: null,
      reviewPreviousJobId: data.automationJobId || null,
      reviewPreviousError: data.automationError || null,
      reviewResolution: "user_verified_not_signed_out",
      reviewResolvedAt: serverTimestamp(),
      automationError: null,
      lastRecoveryDetail: "Operator verified in MSPT that the package was NOT signed out. Previous error: " + (data.automationError || "Unspecified"),
      automationUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  });
}


/* =========================================================
   MANUALLY VERIFIED COMPLETION — REVIEW ONLY
   User has checked MSPT directly and confirmed signed out.
   Separate completionType preserves origin of verification.
========================================================= */
export async function completeReviewedWipItem(internalId, typedId, verifiedSignedOut) {
  const id = normalizeInternalId(internalId);
  if (!id || normalizeInternalId(typedId) !== id || verifiedSignedOut !== true) {
    throw new Error("Verify MSPT, check the confirmation, and enter the exact Internal ID.");
  }
  const reference = doc(db, ITEMS_COLLECTION, id);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists() || snapshot.data().status !== "wip") {
      throw new Error("Item is no longer in WIP.");
    }
    const data = snapshot.data();
    if (data.automationStatus !== "review") {
      throw new Error("Item is no longer awaiting review. Refresh before proceeding.");
    }
    transaction.update(reference, {
      status: "completed",
      completionType: "manually_verified",
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      reviewPreviousJobId: data.automationJobId || null,
      reviewPreviousError: data.automationError || null,
      reviewResolution: "user_verified_signed_out_in_mspt",
      reviewResolvedAt: serverTimestamp(),
      automationStatus: "resolved",
      automationJobId: null,
      automationUpdatedAt: serverTimestamp(),
    });
    return true;
  });
}


/* =========================================================
   FAILED → WAITING
   Only failures classified before Save can be returned without
   an MSPT verification. This is WIP status "ready"; it does not
   queue another job until the user explicitly clicks Sign Out.
========================================================= */
export async function returnFailedWipToWaiting(internalId) {
  const id = normalizeInternalId(internalId);
  if (!id) throw new Error("Internal ID is required.");
  const reference = doc(db, ITEMS_COLLECTION, id);
  return runTransaction(db, async transaction => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists() || snapshot.data().status !== "wip") {
      throw new Error("This item is no longer in WIP.");
    }
    const data = snapshot.data();
    if (data.automationStatus !== "failed") {
      throw new Error("Only failed jobs can be returned directly to Waiting.");
    }
    transaction.update(reference, {
      automationStatus: "ready",
      automationStage: "Returned to Waiting",
      previousFailedJobId: data.automationJobId || null,
      previousFailureReason: data.automationError || null,
      automationJobId: null,
      automationMethod: null,
      automationBatchIds: null,
      automationError: null,
      automationUpdatedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}
