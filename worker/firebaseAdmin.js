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

async function completeWipItem(
  internalId,
  completionType
) {
  const id =
    normalizeInternalId(internalId);

  if (!id) {
    throw new Error(
      "Cannot complete an empty Internal ID."
    );
  }

  const reference = db
    .collection("items")
    .doc(id);

  const snapshot =
    await reference.get();

  if (!snapshot.exists) {
    console.log(
      `WIP: ${id} no longer exists.`
    );

    return {
      completed: false,
      alreadyMissing: true,
    };
  }

  const data = snapshot.data();

  if (data.status === "completed") {
    console.log(
      `WIP: ${id} is already marked completed.`
    );

    return {
      completed: false,
      alreadyCompleted: true,
    };
  }

  if (data.status !== "wip") {
    throw new Error(
      `Refusing to complete ${id}: Firestore status is "${data.status}".`
    );
  }

  await reference.update({
    status: "completed",

    completionType,

    completedAt:
      FieldValue.serverTimestamp(),

    updatedAt:
      FieldValue.serverTimestamp(),
  });

  console.log(
    `WIP: ${id} moved to Completed (${completionType}).`
  );

  return {
    completed: true,
    alreadyCompleted: false,
    alreadyMissing: false,
  };
}

module.exports = {
  db,
  completeWipItem,
};