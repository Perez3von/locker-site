"use strict";

// Separate MSPT Get Signature automation. This does not modify the existing
// Search Package automation. One browser action and one Save for the batch.
const { chromium } = require("playwright");
const { login } = require("./msptApi");
const { createSaveConfirmation } = require("./saveConfirmation");
const { drawIST } = require("./istAutomation");

const MSPT_URL = "https://istmspt.com/packagetrack";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value ?? "").trim().toUpperCase();

async function untilEnabled(locator, timeout = 15000) {
  await locator.waitFor({ state: "visible", timeout });
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await locator.isEnabled()) return;
    await pause(200);
  }
  throw new Error("MSPT control did not become enabled.");
}

async function waitForExactOption(popup, id, timeout = 25000) {
  // IMPORTANT: Only inspect options belonging to the ACTIVE Internal ID
  // popup. A page-wide Telerik option locator can see options from multiple
  // open/stale popups and falsely report the same ID as a duplicate.
  const options = popup.locator('[role="option"]');
  const start = Date.now();
  let previousSnapshot = "";
  let stablePolls = 0;

  while (Date.now() - start < timeout) {
    // Count matching OPTION ELEMENTS, not matching text spans. Some Kendo
    // options render the same .k-list-item-text value more than once.
    const matchIndexes = await options.evaluateAll((nodes, expected) => {
      const normalizeText = text => String(text ?? "").trim().toUpperCase();
      const matches = [];
      nodes.forEach((node, index) => {
        const texts = Array.from(node.querySelectorAll('.k-list-item-text'));
        if (texts.some(element => normalizeText(element.textContent) === expected)) {
          matches.push(index);
        }
      });
      return matches;
    }, id);

    const snapshot = JSON.stringify(matchIndexes);
    stablePolls = snapshot === previousSnapshot ? stablePolls + 1 : 1;
    previousSnapshot = snapshot;

    // Wait for search results to settle before acting on either a unique
    // result or a genuine duplicate. Do not guess among separate records.
    if (stablePolls >= 3 && matchIndexes.length > 1) {
      throw new Error(
        `Internal ID ${id} has ${matchIndexes.length} separate exact options in the active dropdown. ` +
        'Selection is ambiguous; no Save attempted.'
      );
    }
    if (stablePolls >= 3 && matchIndexes.length === 1) {
      const candidate = options.nth(matchIndexes[0]);
      try {
        await candidate.waitFor({ state: "visible", timeout: 1000 });
        const labels = await candidate.locator('.k-list-item-text').allTextContents();
        if (labels.some(text => normalize(text) === id)) return candidate;
      } catch {
        // Telerik may replace the option during a render; poll again.
      }
      stablePolls = 0;
      previousSnapshot = "";
    }
    await pause(250);
  }
  throw new Error(
    `Internal ID ${id}: no settled exact match in the active dropdown after ${timeout / 1000}s. ` +
    'No Save attempted.'
  );
}

async function addInternalId(page, id) {
  const group = page.locator(".signature-package-search-control")
    .filter({ has: page.locator("label.k-label", { hasText: "Internal ID" }) }).first();
  const dropdown = group.locator('[role="combobox"]').first();
  await untilEnabled(dropdown);

  const signedList = page.locator(".signature-package-tracking-numbers .k-list-ul li[role='option'] .k-list-item-text");
  const priorEntries = (await signedList.allTextContents()).map(value => value.trim());
  const before = priorEntries.length;

  await dropdown.click();
  const searchInputs = page.locator(
    '.k-animation-container:visible input[role="searchbox"][placeholder="Search by Internal Id..."]'
  );
  await searchInputs.last().waitFor({ state: "visible", timeout: 15000 });

  // Prefer the focused searchbox (the popup just opened by this click).
  // Fallback to the last visible Internal ID searchbox if Telerik does not
  // autofocus it. Both are safer than a global list of dropdown options.
  const focusedSearch = page.locator(
    '.k-animation-container:visible input[role="searchbox"][placeholder="Search by Internal Id..."]:focus'
  );
  const search = (await focusedSearch.count()) === 1
    ? focusedSearch.first()
    : searchInputs.last();
  const popup = search.locator(
    'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " k-animation-container ")][1]'
  );
  await popup.waitFor({ state: "visible", timeout: 15000 });

  await search.fill(id);
  const option = await waitForExactOption(popup, id);
  await option.click();

  // MSPT automatically adds every tracking number for the chosen Internal ID.
  // Never touch the separate Tracking Number dropdown.
  try {
    await page.waitForFunction(({ oldCount }) => {
      return document.querySelectorAll('.signature-package-tracking-numbers .k-list-ul li[role="option"] .k-list-item-text').length > oldCount;
    }, { oldCount: before }, { timeout: 15000 });
  } catch {
    throw new Error(`${id}: selecting the Internal ID did not increase Signing Tracking Number(s). No Save attempted.`);
  }
  let prior = -1;
  let stable = 0;
  const start = Date.now();
  while (Date.now() - start < 6000) {
    const count = await signedList.count();
    stable = count === prior ? stable + 1 : 0;
    if (count > before && stable >= 3) {
      const trackingEntries = (await signedList.allTextContents()).map(value => value.trim());
      // The UI must retain all previously added tracking entries, not merely
      // increase the total count with unrelated replacements.
      const occurrences = list => list.reduce((m, item) =>
        m.set(item, (m.get(item) || 0) + 1), new Map());
      const afterCount = occurrences(trackingEntries);
      for (const [value, required] of occurrences(priorEntries)) {
        if ((afterCount.get(value) || 0) < required) {
          throw new Error(`${id}: MSPT removed a previously selected tracking entry. No Save attempted.`);
        }
      }
      console.log(`BATCH: ${id} added; signing tracking entries now ${count}.`);
      return { id, beforeCount: before, afterCount: count, trackingEntries };
    }
    prior = count;
    await pause(200);
  }
  throw new Error(`${id}: signing list did not settle. No Save attempted.`);
}

async function processISTBatch(job, { onBeforeSave, onStage } = {}) {
  const ids = [...new Set((job.packageIds || []).map(normalize))];
  if (ids.length < 1 || ids.length > 30 || ids.length !== (job.packageIds || []).length) {
    throw new Error("Invalid batch: 1–30 unique Internal IDs required.");
  }
  const signatureField = String(job.signatureField || "").trim();
  if (!signatureField || signatureField.length > 250) {
    throw new Error("Invalid batch Signed By value.");
  }

  console.log(`BATCH: ${ids.length} Internal IDs, Signed By: ${signatureField}.`);
  if (onStage) await onStage("Signing into MSPT");
  const session = await login();
  // Do not separately search every ID here. The exact Internal ID dropdown
  // selection and growth of MSPT's Signing Tracking Number(s) list are our
  // pre-Save checks. A per-ID preflight adds latency and can disagree with UI.

  if (onStage) await onStage("Opening Get Signature");
  const browser = await chromium.launch({ channel: "chrome", headless: process.env.MSPT_BATCH_SHOW_BROWSER !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.addInitScript(({ token, siteId }) => {
      localStorage.setItem("jwtKey", token);
      localStorage.setItem("siteId", String(siteId));
    }, { token: session.token, siteId: session.siteId });
    await page.goto(MSPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const tab = page.getByRole("tab", { name: "Get Signature", exact: true });
    await tab.waitFor({ state: "visible", timeout: 60000 });
    await tab.click();

    const incoming = page.locator('input[type="radio"][value="1"]').first();
    await incoming.waitFor({ state: "attached", timeout: 15000 });
    if (!(await incoming.isChecked())) await incoming.check({ force: true });

    // Adding every Internal ID automatically populates all of its tracking
    // numbers in the Signing Tracking Number(s) list.
    if (onStage) await onStage(`Selecting ${ids.length} packages`);
    const selected = [];
    for (const id of ids) {
      selected.push(await addInternalId(page, id));
    }

    const signedByGroup = page.locator(".signature-package-field")
      .filter({ has: page.locator("label", { hasText: "Signed By" }) }).first();
    const signedBy = signedByGroup.locator('input.k-input-inner[maxlength="250"]').first();
    await untilEnabled(signedBy);
    await signedBy.fill(signatureField);
    if ((await signedBy.inputValue()).trim() !== signatureField) {
      throw new Error("MSPT Signed By field did not retain the requested value.");
    }

    const startButton = page.getByRole("button", { name: "Start", exact: true });
    await untilEnabled(startButton);
    await startButton.click();
    await page.waitForFunction(() => {
      const box = document.querySelector(".signatureBox");
      return box && !box.classList.contains("k-disabled");
    }, null, { timeout: 15000 });
    if (onStage) await onStage("Drawing and checking IST signature");
    await drawIST(page);
    await untilEnabled(page.getByRole("button", { name: "Clear Signature", exact: true }));

    // Final invariant: every selected ID caused the signing list to grow, and
    // all selected tracking entries remain in MSPT's list before clicking Save.
    // We do not touch the Tracking Number dropdown.
    const entries = (await page.locator(
      ".signature-package-tracking-numbers .k-list-ul li[role='option'] .k-list-item-text"
    ).allTextContents()).map(text => text.trim());
    const lastSelection = selected[selected.length - 1];
    if (!lastSelection || entries.length !== lastSelection.afterCount ||
        entries.length < ids.length ||
        selected.some(item => item.afterCount <= item.beforeCount)) {
      throw new Error("The signing list changed after ID selection. No Save attempted.");
    }
    // Compare occurrences, not just a Set: some carriers may reuse text.
    const counts = values => values.reduce((map, value) => {
      map.set(value, (map.get(value) || 0) + 1);
      return map;
    }, new Map());
    const finalEntries = counts(entries);
    for (const [text, count] of counts(lastSelection.trackingEntries)) {
      if ((finalEntries.get(text) || 0) < count) {
        throw new Error("Signing tracking entries disappeared before Save. No Save attempted.");
      }
    }
    console.log(`BATCH: pre-Save check passed — ${selected.length}/${ids.length} IDs, ${entries.length} tracking entries retained.`);
    if ((await signedBy.inputValue()).trim() !== signatureField) {
      throw new Error("Signed By changed before Save.");
    }

    if (onStage) await onStage("Checking fields before Save");
    const save = page.locator('button.signature-package-button[type="submit"]').filter({ hasText: "Save" }).first();
    await untilEnabled(save);
    // Optional no-submit test. Throws BEFORE the Save checkpoint, so WIP
    // remains retryable. Useful for validating MSPT selectors on a real site.
    if (process.env.MSPT_BATCH_DRY_RUN === "1") {
      throw new Error(`Batch dry run completed: ${ids.length} IDs selected and signature drawn. Save NOT clicked.`);
    }
    // Listen BEFORE the Save click so a fast network response isn't missed.
    // We accept only a real Save-specific API receipt or MSPT success notice,
    // never a bare click or the unrelated package-search endpoint.
    const receipt = createSaveConfirmation(page, { timeoutMs: 12000 });
    await receipt.start();
    try {
      if (typeof onBeforeSave === "function") await onBeforeSave(session);
      console.log(`BATCH: clicking Save ONCE for ${ids.length} IDs.`);
      await save.click(); // Never retry an uncertain Save automatically.
      if (onStage) await onStage("Waiting for MSPT Save confirmation");
      const outcome = await receipt.wait();
      if (!outcome.confirmed) {
        const error = new Error(outcome.error || "MSPT Save was not confirmed.");
        error.saveOutcome = outcome;
        throw error;
      }
      console.log(`BATCH: MSPT Save confirmed via ${outcome.signal}. No per-ID search loop.`);
      return {
        status: "completed", submitted: true, saveAttempted: true,
        saveConfirmed: true, confirmationMethod: outcome.signal,
        signatureField, packageIds: ids, trackingEntries: entries.length,
        // Every selected ID belongs to this confirmed single Save transaction.
        confirmedIds: ids,
      };
    } finally {
      receipt.stop();
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

module.exports = { processISTBatch, addInternalId, waitForExactOption };
