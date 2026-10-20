"use strict";
const fs = require("fs/promises");
const { completeWipItem, setAutomationStatus, setAutomationStage } = require("./firebaseAdmin");
const { processISTBatch } = require("./batchSignature");
const { removeSuccessfulJob } = require("./queueHousekeeping");

async function save(job) {
  const { filepath, ...payload } = job;
  await fs.writeFile(filepath, JSON.stringify(payload, null, 2));
}

async function markAll(job, status, message) {
  await Promise.all((job.packageIds || []).map(async id => {
    try {
      await setAutomationStatus(id, job.id, status, message);
    } catch (error) {
      console.error(`BATCH ${job.id}: could not update ${id}: ${error.message}`);
    }
  }));
}

async function applyConfirmation(job, result) {
  // One positively confirmed Get Signature Save covers EVERY ID that passed
  // selection before that Save. MSPT's search API does not reliably expose
  // all signed-out records, so do not re-search every package 10 times.
  const successIds = new Set(result?.saveConfirmed === true ? result.confirmedIds || [] : []);
  const completed = [], review = [];
  for (const id of job.packageIds) {
    if (successIds.has(id)) {
      try {
        const moved = await completeWipItem(id, "signed_out", job.id);
        if (moved.completed || moved.alreadyCompleted) {
          completed.push(id);
          console.log(`BATCH: ${id} completed (confirmed batch Save).`);
          continue;
        }
        throw new Error("Firestore record missing or claim changed.");
      } catch (error) {
        console.error(`BATCH ${id}: Save confirmed but Firestore update failed: ${error.message}`);
        await setAutomationStatus(id, job.id, "review", `MSPT Save confirmed, but Firestore completion failed: ${error.message}`);
        review.push(id);
        continue;
      }
    }
    const message = result?.diagnostics?.[id] || "MSPT Save response was not confirmed. Check MSPT before retrying.";
    await setAutomationStatus(id, job.id, "review", message);
    review.push(id);
  }
  job.confirmedIds = completed;
  job.reviewIds = review;
  job.status = review.length ? "review" : "completed";
  job.completedAt = new Date().toISOString();
  await save(job);
  if (job.status === "completed") await removeSuccessfulJob(job);
  console.log(`BATCH ${job.id}: ${completed.length} completed; ${review.length} need review.`);
}

async function processBatchJob(job) {
  job.status = "processing";
  job.startedAt = new Date().toISOString();
  await save(job);

  // Canceling a queued batch invalidates ALL member claims. If the worker
  // can't claim every ID, it must NOT submit the batch.
  const claimed = [];
  for (const id of job.packageIds) {
    try {
      if (await setAutomationStatus(id, job.id, "processing")) claimed.push(id);
      else break;
    } catch (error) {
      console.error(`BATCH: claim failed for ${id}: ${error.message}`);
      break;
    }
  }
  if (claimed.length !== job.packageIds.length) {
    job.status = "skipped";
    job.error = "Batch claim was canceled or changed before processing. No Save attempted.";
    await markAll(job, "failed", job.error);
    await save(job);
    return;
  }

  try {
    const result = await processISTBatch(job, {
      onStage: async stage => {
        // Stage updates used to fan out N Firestore writes for EVERY selected ID
        // (N*N writes in a large batch). Keep detailed progress in local logs;
        // Firestore gets only the meaningful processing/save/completion states.
        console.log(`BATCH stage: ${stage}`);
      },
      onBeforeSave: async () => {
        // Durable write BEFORE clicking MSPT Save. After this point, failures
        // cannot be retried automatically without verifying MSPT.
        job.saveAttempted = true;
        job.saveAttemptedAt = new Date().toISOString();
        await save(job);
        await Promise.all(job.packageIds.map(id => setAutomationStage(id, job.id, "Save requested — awaiting MSPT receipt")));
      },
    });
    job.result = result;
    await applyConfirmation(job, result);
  } catch (error) {
    job.error = error?.message || "Unknown batch worker error";
    console.error(`BATCH ${job.id}: ${job.error}`);
    if (!job.saveAttempted) {
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      await markAll(job, "failed", job.error);
      await save(job);
      return;
    }

    // Save was requested but a definitive receipt was not observed. Do NOT
    // spend minutes searching the unreliable package-search endpoint. Preserve
    // every ID for explicit review, and let the worker continue to the next job.
    job.result = { saveConfirmed: false, confirmedIds: [],
      diagnostics: Object.fromEntries(job.packageIds.map(id => [id,
        `Save outcome uncertain: ${job.error}. Check MSPT before retrying ${id}.`])) };
    await applyConfirmation(job, job.result);
  }
}

module.exports = { processBatchJob };
