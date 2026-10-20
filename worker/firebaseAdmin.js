const path = require("path");

const {
  getApps,
  initializeApp,
  cert,
} = require("firebase-admin/app");

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const serviceAccount = require(
  path.join(
    process.cwd(),
    "serviceAccountKey.json"
  )
);

const app =
  getApps().length === 0
    ? initializeApp({
        credential: cert(serviceAccount),
      })
    : getApps()[0];

const db = getFirestore(app);

function normalizeInternalId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

// For batch completions, require the same worker claim that was used to
// process the package. This prevents an old worker from completing a retried ID.
async function completeWipItem(internalId, completionType, expectedJobId = null) {
  const id = normalizeInternalId(internalId);
  if (!id) throw new Error("Cannot complete an empty Internal ID.");
  const reference = db.collection("items").doc(id);
  return db.runTransaction(async tx => {
    const snap = await tx.get(reference);
    if (!snap.exists) return { completed: false, alreadyMissing: true };
    const data = snap.data();
    if (data.status === "completed") return { completed: false, alreadyCompleted: true };
    if (data.status !== "wip") throw new Error(`Cannot complete ${id}: status is ${data.status}.`);
    if (expectedJobId && (data.automationJobId !== expectedJobId || data.automationStatus !== "processing")) {
      throw new Error(`Cannot complete ${id}: job claim changed.`);
    }
    tx.update(reference, {
      status: "completed",
      completionType,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      automationStatus: "completed",
      automationUpdatedAt: FieldValue.serverTimestamp(),
    });
    return { completed: true, alreadyMissing: false, alreadyCompleted: false };
  });
}

async function setAutomationStatus(internalId, jobId, status, error = null) {
  const ref = db.collection("items").doc(normalizeInternalId(internalId));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== "wip" || snap.data().automationJobId !== jobId) return false;
    tx.update(ref, {
      automationStatus: status,
      automationUpdatedAt: FieldValue.serverTimestamp(),
      automationError: error,
      ...(status === "processing" ? { automationStartedAt: FieldValue.serverTimestamp(), automationStage: "Starting MSPT" } : {}),
    });
    return true;
  });
}

// Updates are guarded by the original claim. A canceled job cannot progress.
async function setAutomationStage(internalId, jobId, stage) {
  const ref = db.collection("items").doc(normalizeInternalId(internalId));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data().status !== "wip" ||
        snap.data().automationJobId !== jobId || snap.data().automationStatus !== "processing") return false;
    tx.update(ref, { automationStage: String(stage).slice(0, 100),
      automationUpdatedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

module.exports = {
  setAutomationStage,
  setAutomationStatus,
  db,
  completeWipItem,
};