"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");

const QUEUE_DIR = path.join(process.cwd(), ".automation-queue");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_IMAGE = /^(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(?:before-save|after-save|FAILED|mspt))?\.(?:png|jpe?g)$/i;
const TERMINAL = new Set(["completed", "failed", "review", "skipped", "canceled", "cancelled"]);

async function listCleanupCandidates() {
  let names;
  try { names = await fs.readdir(QUEUE_DIR); }
  catch (error) {
    if (error.code === "ENOENT") return { files: [], activeJobs: 0, unavailableJobs: 0 };
    throw error;
  }
  const terminalIds = new Set();
  const protectedIds = new Set();
  let activeJobs = 0;
  let unavailableJobs = 0;
  const jsonPaths = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (!UUID.test(id)) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(QUEUE_DIR, name), "utf8"));
      if (parsed.id !== id || !TERMINAL.has(parsed.status)) {
        protectedIds.add(id);
        activeJobs++;
      } else {
        terminalIds.add(id);
        jsonPaths.push(name);
      }
    } catch {
      // File may be getting written. Never delete an unknown/incomplete job.
      protectedIds.add(id);
      unavailableJobs++;
    }
  }
  const imagePaths = [];
  for (const name of names) {
    const match = SAFE_IMAGE.exec(name);
    if (!match) continue;
    const id = match.groups.id;
    if (protectedIds.has(id)) continue;
    // With no JSON, these are leftovers from a previously removed job.
    // With a terminal JSON, they're safe to remove too.
    imagePaths.push(name);
  }
  return { files: [...jsonPaths, ...imagePaths], jsonFiles: jsonPaths.length,
    imageFiles: imagePaths.length, activeJobs, unavailableJobs };
}

async function cleanTerminalArtifacts() {
  const scan = await listCleanupCandidates();
  let deleted = 0;
  let failed = 0;
  for (const name of scan.files) {
    const fullPath = path.join(QUEUE_DIR, name);
    try {
      // Before deleting a JSON, re-read the state to limit races with the worker.
      if (name.endsWith(".json")) {
        const job = JSON.parse(await fs.readFile(fullPath, "utf8"));
        if (!TERMINAL.has(job.status)) continue;
      }
      await fs.unlink(fullPath);
      deleted++;
    } catch (error) {
      if (error.code !== "ENOENT") failed++;
    }
  }
  return { deleted, failed, activeJobs: scan.activeJobs, unavailableJobs: scan.unavailableJobs };
}

async function removeSuccessfulJob(job) {
  if (!job || job.status !== "completed" || !UUID.test(job.id)) return;
  // Job has already been durably marked completed in Firestore and its JSON.
  // No screenshot is retained for a successful job, including old debug files.
  const names = [
    `${job.id}.json`,
    `${job.id}-before-save.png`,
    `${job.id}-after-save.png`,
    `${job.id}-FAILED.png`,
    `${job.id}-mspt.png`,
  ];
  for (const name of names) {
    try { await fs.unlink(path.join(QUEUE_DIR, name)); }
    catch (error) { if (error.code !== "ENOENT") console.warn(`Could not clean ${name}: ${error.message}`); }
  }
}

module.exports = { listCleanupCandidates, cleanTerminalArtifacts, removeSuccessfulJob };
