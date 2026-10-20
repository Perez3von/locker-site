const fs = require("fs/promises");
const path = require("path");

const {
  processISTPackage,
} = require("./istAutomation");
const { processBatchJob } = require("./batchJob");
const { removeSuccessfulJob } = require("./queueHousekeeping");

const {
  completeWipItem,
  setAutomationStatus,
  setAutomationStage,
} = require("./firebaseAdmin");

const QUEUE_DIR = path.join(
  process.cwd(),
  ".automation-queue"
);

const POLL_INTERVAL = 1000;

async function ensureQueue() {
  await fs.mkdir(QUEUE_DIR, {
    recursive: true,
  });
}

async function readJobs() {
  const files =
    await fs.readdir(QUEUE_DIR);

  const jobs = [];

  for (const filename of files) {
    if (!filename.endsWith(".json")) {
      continue;
    }

    const filepath = path.join(
      QUEUE_DIR,
      filename
    );

    try {
      const raw =
        await fs.readFile(
          filepath,
          "utf8"
        );

      const job =
        JSON.parse(raw);

      if (job.status === "queued") {
        jobs.push({
          ...job,
          filepath,
        });
      }
    } catch (error) {
      console.error(
        "Bad job file:",
        filename,
        error.message
      );
    }
  }

  jobs.sort((a, b) => {
    return (
      new Date(a.createdAt).getTime() -
      new Date(b.createdAt).getTime()
    );
  });

  return jobs;
}

async function saveJob(job) {
  const {
    filepath,
    ...data
  } = job;

  await fs.writeFile(
    filepath,
    JSON.stringify(
      data,
      null,
      2
    )
  );
}

async function processJob(job) {
  if (job.method === "batch") {
    await processBatchJob(job);
    return;
  }
  job.status = "processing";
  job.startedAt =
    new Date().toISOString();

  await saveJob(job);
  const claimed = await setAutomationStatus(job.packageId, job.id, "processing");
  if (!claimed) {
    job.status = "skipped";
    job.reason = "claim_no_longer_valid";
    await saveJob(job);
    return;
  }

  try {
    const result = await processISTPackage(job, {
      onStage: stage => setAutomationStage(job.packageId, job.id, stage),
      onBeforeSave: async () => {
        // Persist to the queue file before the UI is allowed to click Save.
        // This stays true even if post-Save API verification fails.
        job.saveAttempted = true;
        job.saveAttemptedAt = new Date().toISOString();
        await saveJob(job);
        await setAutomationStage(job.packageId, job.id, "Save requested — verifying result");
      },
    });

    // ===============================================
    // ALREADY SIGNED OUT
    // ===============================================

    if (
      result.status === "skipped" &&
      result.reason ===
        "already_signed_out"
    ) {
      console.log(
        `MSPT confirms ${job.packageId} is already signed out.`
      );

      console.log(
        "Moving item to Completed..."
      );

      const completion =
        await completeWipItem(
          job.packageId,
          "already_signed_out"
        );

      job.status = "completed";

      job.result = {
        ...result,
        completionType:
          "already_signed_out",
        firestore: completion,
      };

      job.completedAt =
        new Date().toISOString();

      await saveJob(job);
      await removeSuccessfulJob(job);

      console.log(
        `JOB ${job.id}: COMPLETED - ALREADY SIGNED OUT`
      );

      return;
    }

    // ===============================================
    // UNKNOWN SKIP
    // ===============================================

    if (result.status === "skipped") {
      await setAutomationStatus(job.packageId, job.id, "review", `Unverified skip: ${result.reason}`);
      job.status = "skipped";
      job.reason = result.reason;
      job.result = result;

      job.completedAt =
        new Date().toISOString();

      await saveJob(job);

      console.log(
        `JOB ${job.id}: SKIPPED`
      );

      return;
    }

    // ===============================================
    // NEW SIGN OUT
    // ===============================================

    if (
      result.status !== "completed" ||
      result.verified !== true ||
      result.submitted !== true
    ) {
      throw new Error(
        `MSPT did not return a verified completed sign-out for ${job.packageId}.`
      );
    }

    console.log(
      `MSPT verified ${job.packageId}.`
    );

    console.log(
      "Moving item to Completed..."
    );

    const completion =
      await completeWipItem(
        job.packageId,
        "signed_out"
      );

    job.status = "completed";

    job.result = {
      ...result,
      completionType:
        "signed_out",
      firestore: completion,
    };

    job.completedAt =
      new Date().toISOString();

    await saveJob(job);
    await removeSuccessfulJob(job);

    console.log(
      `JOB ${job.id}: COMPLETED`
    );
  } catch (error) {
    // A failure before Save is safe to retry after the cause is fixed.
    // Once Save was attempted, do not permit blind retries.
    const needsReview = job.saveAttempted === true;
    job.status = needsReview ? "review" : "failed";
    job.error = error?.message || "Unknown worker error";
    await setAutomationStatus(
      job.packageId,
      job.id,
      needsReview ? "review" : "failed",
      job.error
    );

    job.completedAt =
      new Date().toISOString();

    await saveJob(job);

    console.error(
      `JOB ${job.id}: ${needsReview ? "NEEDS REVIEW (Save may have been attempted)" : "FAILED BEFORE SAVE — safe to retry after fixing the cause"}`
    );

    console.error(error);
  }
}

async function main() {
  await ensureQueue();

  console.log(
    "MSPT worker running."
  );

  console.log(
    "Firestore completion tracking enabled."
  );

  let busy = false;

  while (true) {
    try {
      if (!busy) {
        const jobs =
          await readJobs();

        const job = jobs[0];

        if (job) {
          busy = true;

          await processJob(job);

          busy = false;
        }
      }
    } catch (error) {
      busy = false;

      console.error(
        "Worker loop error:",
        error
      );
    }

    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          POLL_INTERVAL
        )
    );
  }
}

main();