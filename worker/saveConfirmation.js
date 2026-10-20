"use strict";

// Checks the actual MSPT Save operation, not the general package-search API.
// Never turn an unrelated 2xx response into a confirmed sign-out.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SAVING_METHODS = new Set(["POST", "PUT", "PATCH"]);
const SAVE_PATH = /(?:signature|sign[-_]?out|signed|signing)/i;
const SAVE_PAYLOAD = /(?:signature(?:name|type|data|image)?|signedby|signed_by|trackingnumbers)/i;
const SUCCESS_MESSAGE = /\b(?:success(?:ful(?:ly)?)?|saved|completed)\b/i;
const FAIL_MESSAGE = /\b(?:fail(?:ed|ure)?|error|unsuccessful|invalid|denied|rejected)\b/i;

function isCandidate(request) {
  if (!SAVING_METHODS.has(String(request.method()).toUpperCase())) return false;
  let url;
  try { url = new URL(request.url()); } catch { return false; }
  if (!/(^|\.)istmspt\.com$/i.test(url.hostname)) return false;
  const pathIsSave = SAVE_PATH.test(url.pathname);
  const body = String(request.postData?.() || "");
  // The payload test supports MSPT endpoints named generically (e.g. /api/IncomingPackage/update).
  // Require more than just the recipient name: we need signature/tracking evidence.
  const bodyIsSave = SAVE_PAYLOAD.test(body) &&
    /(?:signature(?:data|image|type)?|trackingnumbers|signatures)/i.test(body);
  return pathIsSave || (url.pathname.toLowerCase().includes("/api/") && bodyIsSave);
}

async function classifySaveResponse(response) {
  const status = response.status();
  let urlPath = "MSPT";
  try { urlPath = new URL(response.url()).pathname; } catch { /* no-op */ }
  if (status < 200 || status >= 300) {
    return { ok: false, status, path: urlPath, reason: `MSPT Save request returned HTTP ${status}.` };
  }
  let payload = null;
  try {
    const length = Number(response.headers()?.["content-length"] || 0);
    const type = String(response.headers()?.["content-type"] || "").toLowerCase();
    if ((type.includes("json") || type.includes("text/plain")) && length < 65536) {
      const text = (await response.text()).trim();
      if (text) {
        try { payload = JSON.parse(text); }
        catch { payload = text.slice(0, 250); }
      }
    }
  } catch { /* status and UI are still observable */ }

  if (payload === false ||
      (payload && typeof payload === "object" &&
       (payload.success === false || payload.isSuccess === false || payload.succeeded === false ||
        payload.isSuccessful === false || payload.error ||
        (Array.isArray(payload.errors) && payload.errors.length > 0) ||
        (typeof payload.message === "string" && FAIL_MESSAGE.test(payload.message) && !SUCCESS_MESSAGE.test(payload.message)) ||
        (typeof payload.errorMessage === "string" && FAIL_MESSAGE.test(payload.errorMessage)) ||
        (typeof payload.status === "string" && FAIL_MESSAGE.test(payload.status))))) {
    return { ok: false, status, path: urlPath, reason: "MSPT Save response explicitly reported failure." };
  }
  if (typeof payload === "string" && FAIL_MESSAGE.test(payload) && !SUCCESS_MESSAGE.test(payload)) {
    return { ok: false, status, path: urlPath, reason: "MSPT Save response reported an error." };
  }
  // A successful 2xx reply to the *Save-specific mutation* is accepted as an
  // operation receipt. It is not a per-package query result or mere button click.
  return { ok: true, status, path: urlPath, source: "save-response" };
}

function createSaveConfirmation(page, { timeoutMs = 12000 } = {}) {
  const observed = [];
  const pending = new Set();
  let active = false;
  let closed = false;
  let initialNotices = new Set();
  let saveSuccessObservedAt = 0;
  const debug = process.env.MSPT_BATCH_SAVE_DEBUG === "1";

  const onResponse = response => {
    if (!active || closed) return;
    if (!isCandidate(response.request())) {
      if (debug && SAVING_METHODS.has(response.request().method())) {
        try {
          const path = new URL(response.url()).pathname;
          console.log(`BATCH Save diagnostic: unrelated mutation ${response.request().method()} ${path} -> ${response.status()}`);
        } catch { /* no-op */ }
      }
      return;
    }
    const task = classifySaveResponse(response)
      .then(result => {
        observed.push(result);
        if (debug) console.log(`BATCH Save diagnostic: candidate ${result.path} -> ${result.status} (${result.ok ? "accepted" : "error"})`);
      })
      .catch(() => {})
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  const notices = async () => {
    try {
      return await page.locator(
        ".k-notification-group .k-notification, .k-notification-success, .k-notification-error"
      ).evaluateAll(nodes => nodes.map(node => ({
        text: (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 250),
        success: node.classList.contains("k-notification-success") ||
          Boolean(node.closest(".k-notification-success")),
        error: node.classList.contains("k-notification-error") ||
          Boolean(node.closest(".k-notification-error")),
      })));
    } catch { return []; }
  };

  return {
    async start() {
      initialNotices = new Set((await notices()).map(n => `${n.success}:${n.error}:${n.text}`));
      active = true;
      page.on("response", onResponse);
    },
    async wait() {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const failure = observed.find(v => v.ok === false);
        if (failure) return { confirmed: false, error: failure.reason, signal: "save-response-error" };
        const success = observed.find(v => v.ok === true);
        if (success) {
          if (!saveSuccessObservedAt) saveSuccessObservedAt = Date.now();
          // Give the UI a brief chance to display a business-level error even
          // when the HTTP layer returned 2xx.
          if (Date.now() - saveSuccessObservedAt >= 650) {
            return { confirmed: true, signal: `${success.source}:${success.path}`, httpStatus: success.status };
          }
        }
        const current = await notices();
        for (const notice of current) {
          if (initialNotices.has(`${notice.success}:${notice.error}:${notice.text}`)) continue;
          if (notice.error || FAIL_MESSAGE.test(notice.text)) {
            return { confirmed: false, error: `MSPT displayed an error after Save: ${notice.text}`, signal: "ui-error" };
          }
          if (notice.success && SUCCESS_MESSAGE.test(notice.text)) {
            return { confirmed: true, signal: "success-notification" };
          }
        }
        await sleep(200);
      }
      await Promise.allSettled([...pending]);
      const success = observed.find(v => v.ok === true);
      if (success) return { confirmed: true, signal: `${success.source}:${success.path}`, httpStatus: success.status };
      return {
        confirmed: false,
        signal: "no-save-receipt",
        error: "Save was clicked once, but MSPT did not expose a recognizable successful Save response/notification. Check MSPT before retrying.",
      };
    },
    stop() {
      active = false;
      closed = true;
      page.off("response", onResponse);
    },
  };
}

module.exports = { createSaveConfirmation, isCandidate, classifySaveResponse };
