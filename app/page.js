"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  commitActiveScans,
  removeActiveScan,
  removeActiveScans,
  subscribeToActiveScans,
  updateActiveScan,
} from "../lib/firebase";

/* =========================================================
   CACHE SETTINGS
========================================================= */

const ACTIVE_CACHE_KEY =
  "active-ids-cache-v3";

const DRAFT_CACHE_KEY =
  "active-ids-draft-v3";

const ACTIVE_CACHE_DURATION =
  5 * 60 * 1000;

const DRAFT_CACHE_DURATION =
  24 * 60 * 60 * 1000;

const DRAFT_SAVE_DEBOUNCE = 400;

/* =========================================================
   HELPERS
========================================================= */

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function parseIds(text) {
  return [
    ...new Set(
      String(text || "")
        .split(/[\s,;]+/)
        .map(normalizeId)
        .filter(Boolean)
    ),
  ];
}

function formatTime(timestamp) {
  if (!timestamp) return "";

  return new Intl.DateTimeFormat(
    "en-US",
    {
      hour: "numeric",
      minute: "2-digit",
    }
  ).format(new Date(timestamp));
}

function getDateKey(timestamp) {
  const date = new Date(timestamp);

  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ].join("-");
}

function getDateLabel(timestamp) {
  const target = new Date(timestamp);
  const today = new Date();

  const targetStart = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate()
  );

  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  const difference = Math.round(
    (todayStart.getTime() -
      targetStart.getTime()) /
      86400000
  );

  if (difference === 0) {
    return "Today";
  }

  if (difference === 1) {
    return "Yesterday";
  }

  return target.toLocaleDateString(
    "en-US",
    {
      month: "short",
      day: "numeric",
      year:
        target.getFullYear() !==
        today.getFullYear()
          ? "numeric"
          : undefined,
    }
  );
}

/* =========================================================
   CACHE
========================================================= */

function readCache(key, maxAge) {
  try {
    const raw =
      localStorage.getItem(key);

    if (!raw) return null;

    const cache = JSON.parse(raw);

    if (
      !cache.savedAt ||
      !Array.isArray(cache.data)
    ) {
      localStorage.removeItem(key);
      return null;
    }

    if (
      Date.now() - cache.savedAt >
      maxAge
    ) {
      localStorage.removeItem(key);
      return null;
    }

    return cache.data;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now(),
        data,
      })
    );
  } catch (error) {
    console.error(
      "Cache write failed:",
      error
    );
  }
}

/* =========================================================
   PAGE
========================================================= */

export default function Home() {
  const inputRef = useRef(null);

  const [activeScans, setActiveScans] =
    useState([]);

  const [draftIds, setDraftIds] =
    useState([]);

  const [input, setInput] =
    useState("");

  const [selectedIds, setSelectedIds] =
    useState(() => new Set());

  const [loading, setLoading] =
    useState(true);

  const [connected, setConnected] =
    useState(false);

  const [draftLoaded, setDraftLoaded] =
    useState(false);

  const [committing, setCommitting] =
    useState(false);

  const [removingSelected, setRemovingSelected] =
    useState(false);

  const [editingId, setEditingId] =
    useState(null);

  const [editingValue, setEditingValue] =
    useState("");

  const [message, setMessage] =
    useState("");

  const [messageType, setMessageType] =
    useState("success");

  /* =======================================================
     INITIAL LOAD
  ======================================================= */

  useEffect(() => {
    const activeCache = readCache(
      ACTIVE_CACHE_KEY,
      ACTIVE_CACHE_DURATION
    );

    if (activeCache) {
      setActiveScans(activeCache);
      setLoading(false);
    }

    const draftCache = readCache(
      DRAFT_CACHE_KEY,
      DRAFT_CACHE_DURATION
    );

    if (draftCache) {
      setDraftIds(draftCache);
    }

    setDraftLoaded(true);

    const unsubscribe =
      subscribeToActiveScans(
        (scans) => {
          setActiveScans(scans);

          writeCache(
            ACTIVE_CACHE_KEY,
            scans
          );

          setConnected(true);
          setLoading(false);
        },

        () => {
          setConnected(false);
          setLoading(false);

          if (!activeCache) {
            showMessage(
              "Could not load the shared list.",
              "error"
            );
          }
        }
      );

    return unsubscribe;
  }, []);

  /* =======================================================
     DEBOUNCED LOCAL DRAFT SAVE
  ======================================================= */

  useEffect(() => {
    if (!draftLoaded) return;

    const timer = setTimeout(
      () => {
        writeCache(
          DRAFT_CACHE_KEY,
          draftIds
        );
      },
      DRAFT_SAVE_DEBOUNCE
    );

    return () =>
      clearTimeout(timer);
  }, [draftIds, draftLoaded]);

  /* =======================================================
     REMOVE IDS FROM DRAFT IF THEY BECOME ACTIVE

     Example:
     User A has EMP-100 staged.
     User B adds EMP-100.
     User A's listener receives it and EMP-100 disappears
     from their draft because it no longer needs committing.
  ======================================================= */

  useEffect(() => {
    if (!connected) return;

    const activeSet = new Set(
      activeScans.map(
        (scan) => scan.internalId
      )
    );

    setDraftIds((current) =>
      current.filter(
        (id) => !activeSet.has(id)
      )
    );
  }, [activeScans, connected]);

  /* =======================================================
     CLEAN LOCAL SELECTION
  ======================================================= */

  useEffect(() => {
    const activeSet = new Set(
      activeScans.map(
        (scan) => scan.internalId
      )
    );

    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((id) =>
          activeSet.has(id)
        )
      );

      return next;
    });
  }, [activeScans]);

  /* =======================================================
     DERIVED DATA
  ======================================================= */

  const activeIdSet = useMemo(
    () =>
      new Set(
        activeScans.map(
          (scan) => scan.internalId
        )
      ),
    [activeScans]
  );

  const groupedScans = useMemo(() => {
    const groups = {};

    [...activeScans]
      .sort(
        (a, b) =>
          b.scannedAt -
          a.scannedAt
      )
      .forEach((scan) => {
        const key = getDateKey(
          scan.scannedAt
        );

        if (!groups[key]) {
          groups[key] = {
            key,
            timestamp:
              scan.scannedAt,
            scans: [],
          };
        }

        groups[key].scans.push(
          scan
        );
      });

    return Object.values(groups).sort(
      (a, b) =>
        b.timestamp - a.timestamp
    );
  }, [activeScans]);

  const allSelected =
    activeScans.length > 0 &&
    selectedIds.size ===
      activeScans.length;

  /* =======================================================
     MESSAGE
  ======================================================= */

  function showMessage(
    text,
    type = "success"
  ) {
    setMessage(text);
    setMessageType(type);
  }

  /* =======================================================
     ADD IDS TO LOCAL DRAFT

     NO FIREBASE WRITE.
  ======================================================= */

  function stageIds(text) {
    const parsed = parseIds(text);

    if (parsed.length === 0) {
      return;
    }

    const currentDraft =
      new Set(draftIds);

    const newIds = [];

    let activeDuplicates = 0;
    let draftDuplicates = 0;

    for (const id of parsed) {
      if (activeIdSet.has(id)) {
        activeDuplicates++;
        continue;
      }

      if (currentDraft.has(id)) {
        draftDuplicates++;
        continue;
      }

      currentDraft.add(id);
      newIds.push(id);
    }

    if (newIds.length > 0) {
      setDraftIds((current) => [
        ...current,
        ...newIds,
      ]);
    }

    const status = [];

    if (newIds.length > 0) {
      status.push(
        `${newIds.length} staged`
      );
    }

    if (activeDuplicates > 0) {
      status.push(
        `${activeDuplicates} already active`
      );
    }

    if (draftDuplicates > 0) {
      status.push(
        `${draftDuplicates} already staged`
      );
    }

    showMessage(
      status.join(" · ") ||
        "No new IDs"
    );
  }

  /* =======================================================
     STAGE BUTTON
  ======================================================= */

  function handleStage() {
    if (!input.trim()) return;

    stageIds(input);
    setInput("");

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  /* =======================================================
     PHYSICAL SCANNER

     A scanner normally types one ID and sends Enter.

     If the textarea has one line, Enter stages it.

     Shift+Enter still allows a manual newline.
  ======================================================= */

  function handleInputKeyDown(event) {
    if (
      event.key !== "Enter" ||
      event.shiftKey
    ) {
      return;
    }

    const ids = parseIds(input);

    /*
    If one ID exists, treat Enter like a physical scanner.

    For a manually pasted multi-ID list, the user can use
    the Stage IDs button.
    */

    if (ids.length === 1) {
      event.preventDefault();

      stageIds(input);
      setInput("");
    }
  }

  /* =======================================================
     DRAFT MANAGEMENT
  ======================================================= */

  function removeDraft(id) {
    setDraftIds((current) =>
      current.filter(
        (item) => item !== id
      )
    );
  }

  function clearDraft() {
    setDraftIds([]);
    setInput("");

    showMessage("Draft cleared");

    inputRef.current?.focus();
  }

  /* =======================================================
     COMMIT DRAFT TO FIRESTORE
  ======================================================= */

  async function handleCommit() {
    if (
      draftIds.length === 0 ||
      committing
    ) {
      return;
    }

    if (!connected) {
      showMessage(
        "Database connection is unavailable. Your draft is still saved locally.",
        "error"
      );

      return;
    }

    const idsToCommit = [
      ...draftIds,
    ];

    setCommitting(true);

    try {
      const result =
        await commitActiveScans(
          idsToCommit
        );

      /*
      Remove only IDs that Firestore either:

      1. successfully added
      2. confirmed already existed

      Failed IDs remain in the local draft.
      */

      const completed = new Set([
        ...result.added,
        ...result.skipped,
      ]);

      setDraftIds((current) =>
        current.filter(
          (id) =>
            !completed.has(id)
        )
      );

      if (
        result.failed.length > 0
      ) {
        showMessage(
          `${result.added.length} added · ${result.skipped.length} already active · ${result.failed.length} kept in draft`,
          "error"
        );
      } else if (
        result.skipped.length > 0
      ) {
        showMessage(
          `${result.added.length} added · ${result.skipped.length} already active`
        );
      } else {
        showMessage(
          `${result.added.length} added`
        );
      }
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not add IDs. Your draft is still saved locally.",
        "error"
      );
    } finally {
      setCommitting(false);

      inputRef.current?.focus();
    }
  }

  /* =======================================================
     ACTIVE SELECTION
  ======================================================= */

  function toggleSelection(id) {
    setSelectedIds((current) => {
      const next =
        new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function selectAll() {
    setSelectedIds(
      new Set(
        activeScans.map(
          (scan) =>
            scan.internalId
        )
      )
    );
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  /* =======================================================
     EDIT ACTIVE ID
  ======================================================= */

  function beginEdit(scan) {
    setEditingId(
      scan.internalId
    );

    setEditingValue(
      scan.internalId
    );
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingValue("");
  }

  async function saveEdit() {
    const newId =
      normalizeId(editingValue);

    if (!editingId || !newId) {
      return;
    }

    if (newId === editingId) {
      cancelEdit();
      return;
    }

    try {
      await updateActiveScan(
        editingId,
        newId
      );

      setSelectedIds(
        (current) => {
          const next =
            new Set(current);

          if (
            next.has(editingId)
          ) {
            next.delete(
              editingId
            );

            next.add(newId);
          }

          return next;
        }
      );

      showMessage(
        `${editingId} changed to ${newId}`
      );

      cancelEdit();
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not update ID.",
        "error"
      );
    }
  }

  /* =======================================================
     DELETE ACTIVE ID
  ======================================================= */

  async function handleRemove(id) {
    try {
      await removeActiveScan(id);

      showMessage(
        `${id} removed`
      );
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not remove ID.",
        "error"
      );
    }
  }

  /* =======================================================
     DELETE SELECTED
  ======================================================= */

  async function handleRemoveSelected() {
    const ids = [
      ...selectedIds,
    ];

    if (
      ids.length === 0 ||
      removingSelected
    ) {
      return;
    }

    setRemovingSelected(true);

    try {
      await removeActiveScans(ids);

      setSelectedIds(
        new Set()
      );

      showMessage(
        `${ids.length} removed`
      );
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not remove selected IDs.",
        "error"
      );
    } finally {
      setRemovingSelected(false);
    }
  }

  /* =======================================================
     UI
  ======================================================= */

  return (
    <main className="app-shell">
      {/* =================================================
          HEADER
      ================================================== */}

      <header className="topbar">
        <div className="topbar-inner">
          <div>
            <h1>Active IDs</h1>

            <p>
              Shared ID list
            </p>
          </div>

          <div className="sync-status">
            <span
              className={`sync-dot ${
                connected
                  ? "online"
                  : ""
              }`}
            />

            {connected
              ? "Synced"
              : "Connecting"}
          </div>
        </div>
      </header>

      <div className="content">
        {/* =================================================
            ADD / STAGE IDS
        ================================================== */}

        <section className="add-card">
          <div className="section-heading">
            <div>
              <h2>Add IDs</h2>

              <p>
                Scan one ID or paste multiple IDs.
                Review them before adding.
              </p>
            </div>
          </div>

          <textarea
            ref={inputRef}
            className="id-input"
            value={input}
            onChange={(event) =>
              setInput(
                event.target.value
              )
            }
            onKeyDown={
              handleInputKeyDown
            }
            placeholder={
              "Scan or paste IDs...\n\nEMP-90421\nEMP-88301\nEMP-84920"
            }
            autoFocus
          />

          <div className="input-actions">
            <span className="input-hint">
              Enter stages a scanned ID
            </span>

            <button
              className="secondary-button"
              onClick={handleStage}
              disabled={
                !input.trim()
              }
            >
              Stage IDs
            </button>
          </div>

          {/* ===============================================
              DRAFT
          ================================================ */}

          {draftIds.length > 0 && (
            <div className="draft">
              <div className="draft-header">
                <div>
                  <h3>Draft</h3>

                  <span>
                    {draftIds.length}{" "}
                    {draftIds.length === 1
                      ? "ID"
                      : "IDs"}{" "}
                    ready
                  </span>
                </div>

                <button
                  className="text-button"
                  onClick={clearDraft}
                >
                  Clear
                </button>
              </div>

              <div className="draft-list">
                {draftIds.map(
                  (id) => (
                    <div
                      className="draft-row"
                      key={id}
                    >
                      <span>{id}</span>

                      <button
                        className="icon-button"
                        onClick={() =>
                          removeDraft(id)
                        }
                        aria-label={`Remove ${id}`}
                        title="Remove"
                      >
                        ×
                      </button>
                    </div>
                  )
                )}
              </div>

              <div className="draft-footer">
                <div className="local-save">
                  <span className="local-dot" />

                  Saved locally
                </div>

                <button
                  className="primary-button"
                  onClick={
                    handleCommit
                  }
                  disabled={
                    committing ||
                    !connected
                  }
                >
                  {committing
                    ? "Adding..."
                    : `Add ${draftIds.length} to Active`}
                </button>
              </div>
            </div>
          )}

          {message && (
            <div
              className={`message ${
                messageType ===
                "error"
                  ? "error"
                  : ""
              }`}
            >
              <span>
                {messageType ===
                "error"
                  ? "!"
                  : "✓"}
              </span>

              {message}
            </div>
          )}
        </section>

        {/* =================================================
            ACTIVE LIST HEADER
        ================================================== */}

        <section className="active-section">
          <div className="active-header">
            <div className="active-title">
              <h2>Active</h2>

              <span className="count">
                {activeScans.length}
              </span>
            </div>

            <div className="list-actions">
              <button
                className="text-button"
                onClick={
                  allSelected
                    ? clearSelection
                    : selectAll
                }
                disabled={
                  activeScans.length ===
                  0
                }
              >
                {allSelected
                  ? "Clear selection"
                  : "Select all"}
              </button>

              {selectedIds.size >
                0 && (
                <button
                  className="text-button danger"
                  onClick={
                    handleRemoveSelected
                  }
                  disabled={
                    removingSelected
                  }
                >
                  {removingSelected
                    ? "Removing..."
                    : `Remove selected (${selectedIds.size})`}
                </button>
              )}
            </div>
          </div>

          {/* ===============================================
              LOADING / EMPTY
          ================================================ */}

          {loading &&
            activeScans.length ===
              0 && (
              <div className="empty-state">
                <div className="empty-icon">
                  …
                </div>

                <h3>
                  Loading IDs
                </h3>

                <p>
                  Checking the shared list.
                </p>
              </div>
            )}

          {!loading &&
            activeScans.length ===
              0 && (
              <div className="empty-state">
                <div className="empty-icon">
                  +
                </div>

                <h3>
                  No active IDs
                </h3>

                <p>
                  Add IDs above to get started.
                </p>
              </div>
            )}

          {/* ===============================================
              DATE GROUPS
          ================================================ */}

          {groupedScans.map(
            (group) => (
              <div
                className="date-group"
                key={group.key}
              >
                <div className="date-label">
                  <span>
                    {getDateLabel(
                      group.timestamp
                    )}
                  </span>

                  <span className="date-count">
                    {
                      group.scans
                        .length
                    }
                  </span>
                </div>

                <div className="active-list">
                  {group.scans.map(
                    (scan) => (
                      <div
                        className={`active-row ${
                          selectedIds.has(
                            scan.internalId
                          )
                            ? "selected"
                            : ""
                        }`}
                        key={
                          scan.internalId
                        }
                      >
                        <input
                          className="row-checkbox"
                          type="checkbox"
                          checked={selectedIds.has(
                            scan.internalId
                          )}
                          onChange={() =>
                            toggleSelection(
                              scan.internalId
                            )
                          }
                          aria-label={`Select ${scan.internalId}`}
                        />

                        {editingId ===
                        scan.internalId ? (
                          <div className="edit-row">
                            <input
                              className="edit-input"
                              value={
                                editingValue
                              }
                              onChange={(
                                event
                              ) =>
                                setEditingValue(
                                  event
                                    .target
                                    .value
                                )
                              }
                              onKeyDown={(
                                event
                              ) => {
                                if (
                                  event.key ===
                                  "Enter"
                                ) {
                                  saveEdit();
                                }

                                if (
                                  event.key ===
                                  "Escape"
                                ) {
                                  cancelEdit();
                                }
                              }}
                              autoFocus
                            />

                            <button
                              className="save-button"
                              onClick={
                                saveEdit
                              }
                            >
                              Save
                            </button>

                            <button
                              className="text-button"
                              onClick={
                                cancelEdit
                              }
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="row-main">
                              <strong>
                                {
                                  scan.internalId
                                }
                              </strong>

                              <span>
                                Added{" "}
                                {formatTime(
                                  scan.scannedAt
                                )}
                              </span>
                            </div>

                            <div className="row-actions">
                              <button
                                className="icon-button"
                                onClick={() =>
                                  beginEdit(
                                    scan
                                  )
                                }
                                aria-label={`Edit ${scan.internalId}`}
                                title="Edit"
                              >
                                ✎
                              </button>

                              <button
                                className="icon-button delete"
                                onClick={() =>
                                  handleRemove(
                                    scan.internalId
                                  )
                                }
                                aria-label={`Remove ${scan.internalId}`}
                                title="Remove"
                              >
                                ×
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )
                  )}
                </div>
              </div>
            )
          )}
        </section>
      </div>
    </main>
  );
}