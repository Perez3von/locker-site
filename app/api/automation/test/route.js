import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const runtime = "nodejs";

const QUEUE_DIR = path.join(process.cwd(), ".automation-queue");
const normalize = (value) => String(value ?? "").trim().toUpperCase();
const LOCKED = new Set(["queued", "processing", "review"]);

async function getAdminDb() {
  const existingApps = getApps();
  if (existingApps.length) return getFirestore(existingApps[0]);

  // Read at runtime so Next.js does not try to bundle the service account key.
  const serviceAccount = JSON.parse(
    await fs.readFile(path.join(process.cwd(), "serviceAccountKey.json"), "utf8")
  );
  const app = initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const ids = [...new Set(
      (Array.isArray(body.ids) ? body.ids : []).map(normalize).filter(Boolean)
    )];

    if (!ids.length) {
      return Response.json({ error: "No WIP items selected." }, { status: 400 });
    }
    if (ids.length > 200) {
      return Response.json({ error: "Maximum 200 items per request." }, { status: 400 });
    }

    // Optional user override. When omitted, use EACH item's original
    // signatureName as saved in Collect (not a blanket RETAG for the batch).
    const hasOverride = Object.prototype.hasOwnProperty.call(body, "signatureField");
    const override = hasOverride && typeof body.signatureField === "string"
      ? body.signatureField.trim()
      : null;
    if (hasOverride && (!override || override.length > 250)) {
      return Response.json(
        { error: "Signed By override must contain 1 to 250 characters." },
        { status: 400 }
      );
    }

    const method = body.method === undefined ? "individual" : body.method;
    if (method !== "individual" && method !== "batch") {
      return Response.json({ error: "Unknown sign-out method." }, { status: 400 });
    }
    if (method === "batch" && (ids.length < 1 || ids.length > 30)) {
      return Response.json({ error: "Batch requires 1–30 Internal IDs." }, { status: 400 });
    }

    const db = await getAdminDb();
    await fs.mkdir(QUEUE_DIR, { recursive: true });
    if (method === "batch") {
      // One Firestore transaction claims the entire batch or nothing.
      // All reads must occur before all writes in a Firestore transaction.
      const jobId = crypto.randomUUID();
      const refs = ids.map(id => db.collection("items").doc(id));
      let signatureField;
      try {
        signatureField = await db.runTransaction(async tx => {
          const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
          const names = [];
          for (let i = 0; i < snapshots.length; i++) {
            const snap = snapshots[i];
            if (!snap.exists || snap.data().status !== "wip") {
              throw new Error(`${ids[i]} is not in WIP. No items were queued.`);
            }
            if (LOCKED.has(snap.data().automationStatus)) {
              throw new Error(`${ids[i]} is already queued, processing, or needs review. No items were queued.`);
            }
            const record = snap.data();
            const assignedName = typeof record.signatureName === "string"
              ? record.signatureName.trim() : "RETAG";
            if (!assignedName || assignedName.length > 250) {
              throw new Error(`${ids[i]} has an invalid Signed By value.`);
            }
            names.push(assignedName);
          }
          const chosen = override ?? names[0];
          if (!override && names.some(name => name !== chosen)) {
            throw new Error("Batch requires one Signed By value. Selected IDs differ; enable override in WIP.");
          }
          for (const ref of refs) {
            tx.update(ref, {
              automationStatus: "queued",
              automationJobId: jobId,
              automationMethod: "batch",
              automationBatchIds: ids,
              automationUpdatedAt: FieldValue.serverTimestamp(),
              automationError: null,
            });
          }
          return chosen;
        });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 409 });
      }

      const job = {
        id: jobId,
        method: "batch",
        packageIds: ids,
        signatureField,
        canvasSignature: "IST",
        status: "queued",
        createdAt: new Date().toISOString(),
      };
      try {
        await fs.writeFile(path.join(QUEUE_DIR, `${jobId}.json`),
          JSON.stringify(job, null, 2), { flag: "wx" });
      } catch (error) {
        await db.runTransaction(async tx => {
          const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
          snapshots.forEach((snap, i) => {
            if (snap.exists && snap.data().status === "wip" &&
              snap.data().automationJobId === jobId &&
              snap.data().automationStatus === "queued") {
              tx.update(refs[i], {
                automationStatus: "failed",
                automationError: "Batch queue file creation failed",
                automationUpdatedAt: FieldValue.serverTimestamp(),
              });
            }
          });
        });
        throw error;
      }
      return Response.json({ queued: true, method: "batch", count: ids.length,
        jobs: [{ jobId, packageIds: ids }], skipped: [], skippedReasons: {} });
    }

    const jobs = [];
    const skipped = [];
    const skippedReasons = {};

    for (const packageId of ids) {
      const jobId = crypto.randomUUID();
      const ref = db.collection("items").doc(packageId);

      const claim = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== "wip") {
          return { ok: false, reason: "Item is no longer in WIP" };
        }
        const record = snap.data();
        if (LOCKED.has(record.automationStatus)) {
          return { ok: false, reason: "Already queued, processing, or needs review" };
        }

        // Legacy WIP items created before this feature had no signatureName.
        const assignedName = typeof record.signatureName === "string"
          ? record.signatureName.trim()
          : "RETAG";
        const signatureField = override ?? assignedName;
        if (!signatureField || signatureField.length > 250) {
          return { ok: false, reason: "Saved Signed By name is invalid" };
        }

        tx.update(ref, {
          automationStatus: "queued",
          automationJobId: jobId,
          automationMethod: "individual",
          automationBatchIds: null,
          automationUpdatedAt: FieldValue.serverTimestamp(),
          automationError: null,
        });
        return { ok: true, signatureField };
      });

      if (!claim.ok) {
        skipped.push(packageId);
        skippedReasons[packageId] = claim.reason;
        continue;
      }

      const job = {
        id: jobId,
        method: "individual",
        packageId,
        signatureField: claim.signatureField,
        canvasSignature: "IST",
        status: "queued",
        createdAt: new Date().toISOString(),
      };

      try {
        await fs.writeFile(
          path.join(QUEUE_DIR, `${jobId}.json`),
          JSON.stringify(job, null, 2),
          { flag: "wx" }
        );
        jobs.push({ jobId, packageId });
      } catch (error) {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (
            snap.exists &&
            snap.data().automationJobId === jobId &&
            snap.data().automationStatus === "queued"
          ) {
            tx.update(ref, {
              automationStatus: "failed",
              automationError: "Queue file creation failed",
              automationUpdatedAt: FieldValue.serverTimestamp(),
            });
          }
        });
        throw error;
      }
    }

    return Response.json({
      queued: jobs.length > 0,
      count: jobs.length,
      jobs,
      skipped,
      skippedReasons,
    });
  } catch (error) {
    console.error("Could not queue automation:", error);
    return Response.json(
      { error: error?.message || "Could not queue automation." },
      { status: 500 }
    );
  }
}
