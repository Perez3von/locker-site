"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteCompletedMatching,
  deleteCompletedSelected,
  getCompletedCount,
  getCompletedPage,
} from "../../lib/firebase";
import styles from "./CompletedPage.module.css";

const EMPTY_FILTERS = Object.freeze({
  startDate: "",
  endDate: "",
  completionType: "",
  signatureName: "",
});

function completionLabel(type) {
  return type === "already_signed_out" ? "Already signed out" : "Signed out";
}

function dateTime(value) {
  if (!Number.isFinite(value)) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(value);
}

function dateHeading(value) {
  if (!Number.isFinite(value)) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric" }).format(value);
}

function localDayKey(value) {
  if (!Number.isFinite(value)) return "unknown";
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function filtersSummary(filters) {
  const parts = [];
  if (filters.startDate) parts.push(`from ${filters.startDate}`);
  if (filters.endDate) parts.push(`through ${filters.endDate}`);
  if (filters.completionType) parts.push(completionLabel(filters.completionType));
  if (filters.signatureName) parts.push(`Signed By “${filters.signatureName}”`);
  return parts.length ? parts.join(" · ") : "No filters applied";
}

function validateDates(filters) {
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    throw new Error("End date must be on or after start date.");
  }
  if (filters.signatureName.trim().length > 250) {
    throw new Error("Signed By may contain at most 250 characters.");
  }
}

export default function CompletedPage() {
  const [draft, setDraft] = useState({ ...EMPTY_FILTERS });
  const [applied, setApplied] = useState({ ...EMPTY_FILTERS });
  const [cursors, setCursors] = useState([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [lastDocument, setLastDocument] = useState(null);
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState(() => new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteMode, setDeleteMode] = useState(null); // selected | filtered
  const [deleteCount, setDeleteCount] = useState(null);
  const [countLoading, setCountLoading] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletedProgress, setDeletedProgress] = useState(0);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupKey, setCleanupKey] = useState("");
  const [cleanupConfirmation, setCleanupConfirmation] = useState("");
  const [cleanupPreview, setCleanupPreview] = useState(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState("");

  // Previous versions cached all loaded history and replayed hundreds of
  // reads to reconstruct a Firestore cursor. The new page needs no cache.
  useEffect(() => {
    try { localStorage.removeItem("locker-completed-cache-v1"); } catch { /* optional */ }
  }, []);

  const activeCursor = cursors[pageIndex] ?? null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    getCompletedPage(activeCursor, applied)
      .then(result => {
        if (cancelled) return;
        setItems(result.items);
        setLastDocument(result.lastDocument);
        setHasMore(result.hasMore);
        setSelected(new Set());
      })
      .catch(err => {
        if (cancelled) return;
        setItems([]);
        setHasMore(false);
        setError(err?.message || "Could not load completed packages.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeCursor, applied, refreshKey]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of items) {
      const key = localDayKey(item.completedAt);
      if (!map.has(key)) map.set(key, { key, date: item.completedAt, items: [] });
      map.get(key).items.push(item);
    }
    return [...map.values()];
  }, [items]);

  const allSelected = items.length > 0 && items.every(item => selected.has(item.internalId));
  const filtersActive = Boolean(applied.startDate || applied.endDate || applied.completionType || applied.signatureName);

  function resetPagination() {
    setCursors([null]);
    setPageIndex(0);
    setLastDocument(null);
    setSelected(new Set());
  }

  function applyFilters(event) {
    event?.preventDefault?.();
    try {
      const next = { ...draft, signatureName: draft.signatureName.trim() };
      validateDates(next);
      setError("");
      setNotice("");
      resetPagination();
      setApplied(next);
    } catch (err) {
      setError(err.message);
    }
  }

  function clearFilters() {
    setDraft({ ...EMPTY_FILTERS });
    setApplied({ ...EMPTY_FILTERS });
    resetPagination();
    setError("");
    setNotice("");
  }

  function nextPage() {
    if (loading || !hasMore || !lastDocument) return;
    setCursors(current => [...current.slice(0, pageIndex + 1), lastDocument]);
    setPageIndex(index => index + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function previousPage() {
    if (loading || pageIndex === 0) return;
    setPageIndex(index => index - 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleId(id) {
    if (deleting) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (deleting) return;
    setSelected(allSelected ? new Set() : new Set(items.map(item => item.internalId)));
  }

  const closeDialog = useCallback(() => {
    if (deleting) return;
    setDeleteMode(null);
    setDeleteText("");
    setDeleteCount(null);
  }, [deleting]);

  async function openDeleteDialog(mode) {
    if (loading || deleting) return;
    if (mode === "selected" && !selected.size) return;
    if (mode === "filtered" && !applied.endDate) {
      setError("Choose and apply an end date before deleting matching history.");
      return;
    }
    setDeleteMode(mode);
    setDeleteText("");
    setDeleteCount(mode === "selected" ? selected.size : null);
    setDeletedProgress(0);
    setError("");
    if (mode === "filtered") {
      setCountLoading(true);
      try {
        const count = await getCompletedCount(applied);
        setDeleteCount(count);
      } catch (err) {
        setError(err?.message || "Could not preview matching records.");
        setDeleteMode(null);
      } finally {
        setCountLoading(false);
      }
    }
  }

  async function confirmDeletion() {
    if (deleteText !== "DELETE" || deleting || countLoading || !deleteMode) return;
    setDeleting(true);
    setError("");
    setNotice("");
    try {
      if (deleteMode === "selected") {
        const count = await deleteCompletedSelected([...selected], applied);
        setNotice(`${count} completed record${count === 1 ? "" : "s"} permanently deleted.`);
      } else {
        const result = await deleteCompletedMatching(applied, setDeletedProgress);
        setNotice(`${result.deleted} completed record${result.deleted === 1 ? "" : "s"} permanently deleted.${result.reachedSafetyLimit ? " Safety limit reached (2,000 per action). Repeat to delete additional matches." : ""}`);
      }
      setDeleteMode(null);
      setDeleteText("");
      setDeleteCount(null);
      resetPagination();
      setRefreshKey(key => key + 1);
    } catch (err) {
      setError(`Deletion interrupted: ${err?.message || "Unknown error"}. Some earlier batches may already have been deleted. Refresh to check.`);
      setDeleteMode(null);
    } finally {
      setDeleting(false);
    }
  }

  async function callCleanup(action, confirmation) {
    const response = await fetch("/api/automation/cleanup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cleanupKey ? { "x-locker-cleanup-key": cleanupKey } : {}),
      },
      body: JSON.stringify({ action, ...(confirmation ? { confirmation } : {}) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || "Could not access the queue folder.");
    return data;
  }

  async function previewCleanup() {
    if (cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupMessage("");
    try {
      setCleanupPreview(await callCleanup("preview"));
      setCleanupOpen(true);
      setCleanupConfirmation("");
    } catch (error) {
      setCleanupMessage(error?.message || "Could not inspect queue files.");
    } finally { setCleanupBusy(false); }
  }

  async function deleteQueueArtifacts() {
    if (cleanupBusy || cleanupConfirmation !== "CLEAR FILES") return;
    setCleanupBusy(true);
    try {
      const result = await callCleanup("delete", "CLEAR FILES");
      setCleanupMessage(`${result.deleted} local job file(s) removed.${result.activeJobs ? ` ${result.activeJobs} active job(s) left untouched.` : ""}${result.failed ? ` ${result.failed} file(s) could not be removed.` : ""}`);
      setCleanupOpen(false);
      setCleanupPreview(null);
      setCleanupConfirmation("");
    } catch (error) {
      setCleanupMessage(error?.message || "Cleanup failed.");
    } finally { setCleanupBusy(false); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">Locker</Link>
          <nav className="nav-tabs" aria-label="Main navigation">
            <Link href="/" className="nav-tab">Collect</Link>
            <Link href="/wip" className="nav-tab">WIP</Link>
            <Link href="/completed" className="nav-tab active" aria-current="page">Completed</Link>
          </nav>
          <div className="sync-status"><span className={`sync-dot ${error ? "" : "online"}`} />{error ? "Attention" : "History"}</div>
        </div>
      </header>

      <div className={styles.page}>
        <div className={styles.heading}>
          <div>
            <h1>Completed</h1>
            <p>Browse signed-out history without loading the entire database.</p>
          </div>
          <div className={styles.pageCount}><span>Current page</span><strong>{items.length}</strong><small>up to 50 records</small></div>
        </div>

        <section className={styles.panel} aria-label="Completed filters">
          <div className={styles.sectionTitle}><strong>Find records</strong><span>Filters run in Firestore, not after downloading history.</span></div>
          <form onSubmit={applyFilters} className={styles.filters}>
            <label className={styles.field}><span>From date</span><input type="date" value={draft.startDate} onChange={event => setDraft(old => ({ ...old, startDate: event.target.value }))} /></label>
            <label className={styles.field}><span>Through date</span><input type="date" value={draft.endDate} onChange={event => setDraft(old => ({ ...old, endDate: event.target.value }))} /></label>
            <label className={styles.field}><span>Completion reason</span>
              <select value={draft.completionType} onChange={event => setDraft(old => ({ ...old, completionType: event.target.value }))}>
                <option value="">Any reason</option>
                <option value="signed_out">Signed out</option>
                <option value="already_signed_out">Already signed out</option>
              </select>
            </label>
            <label className={styles.field}><span>Signed By</span><input type="text" maxLength={250} placeholder="RETAG, RTS, name (exact)" value={draft.signatureName} onChange={event => setDraft(old => ({ ...old, signatureName: event.target.value }))} /></label>
            <div className={styles.filterActions}>
              <button type="submit" className={styles.primaryButton} disabled={loading || deleting}>Apply filters</button>
              <button type="button" className={styles.secondaryButton} onClick={clearFilters} disabled={loading || deleting}>Clear</button>
            </div>
          </form>
          {filtersActive && <p className={styles.activeFilters}><strong>Showing:</strong> {filtersSummary(applied)}</p>}
        </section>

        {error && <div role="alert" className={styles.error}>{error}</div>}
        {notice && <div role="status" className={styles.notice}>{notice}</div>}

        <section className={styles.panel} aria-label="Completed records">
          <div className={styles.listToolbar}>
            <label className={styles.selectAll}><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!items.length || loading || deleting}/><span>{allSelected ? "Deselect page" : "Select page"}</span></label>
            <span className={styles.selectedCount}>{selected.size ? `${selected.size} selected` : `Page ${pageIndex + 1}`}</span>
            <div className={styles.toolbarActions}>
              {selected.size > 0 && <button type="button" className={styles.dangerButton} disabled={loading || deleting} onClick={() => openDeleteDialog("selected")}>Delete selected ({selected.size})</button>}
              <button type="button" className={styles.outlineDanger} disabled={!applied.endDate || loading || deleting} onClick={() => openDeleteDialog("filtered")} title={!applied.endDate ? "Apply an end date to enable historical cleanup" : "Delete all completed records matching your active filters"}>Delete matching history</button>
            </div>
          </div>

          {loading ? <div className={styles.empty}>Loading this page…</div> : items.length === 0 ? (
            <div className={styles.empty}>
              <strong>No completed records found</strong>
              <span>Try different filters or return to WIP.</span>
              <Link href="/wip">View WIP</Link>
            </div>
          ) : <div className={styles.groups}>
            {groups.map(group => (
              <div className={styles.group} key={group.key}>
                <div className={styles.groupHeading}><strong>{dateHeading(group.date)}</strong><span>{group.items.length}</span></div>
                <div className={styles.list}>
                  {group.items.map(item => (
                    <div className={`${styles.item} ${selected.has(item.internalId) ? styles.itemSelected : ""}`} key={item.documentId}>
                      <label className={styles.itemCheckbox}><input aria-label={`Select ${item.internalId}`} type="checkbox" checked={selected.has(item.internalId)} disabled={deleting} onChange={() => toggleId(item.internalId)}/></label>
                      <div className={styles.itemMain}><strong>{item.internalId}</strong><span>{dateTime(item.completedAt)}</span><small>Signed By: {item.signatureName || "Not recorded"}</small></div>
                      <div className={styles.itemReason}>{completionLabel(item.completionType)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>}

          <div className={styles.pagination}>
            <button className={styles.secondaryButton} type="button" onClick={previousPage} disabled={loading || deleting || pageIndex === 0}>Previous</button>
            <span>Page {pageIndex + 1} · {items.length} shown</span>
            <button className={styles.secondaryButton} type="button" onClick={nextPage} disabled={loading || deleting || !hasMore}>Next</button>
          </div>
        </section>
        <section className={styles.panel} aria-label="Local job file cleanup">
          <div className={styles.sectionTitle}>
            <strong>Local automation files</strong>
            <span>Remove old screenshots and finished-job JSON files from the server's .automation-queue folder. This does not delete any Firestore history.</span>
          </div>
          <div className={styles.cleanupControls}>
            <label className={styles.field}>
              <span>Cleanup access key (only if configured)</span>
              <input type="password" autoComplete="off" placeholder="Optional on localhost" value={cleanupKey} onChange={event => setCleanupKey(event.target.value)} />
            </label>
            <button type="button" className={styles.secondaryButton} onClick={previewCleanup} disabled={cleanupBusy}>
              {cleanupBusy ? "Checking…" : "Review local files to clear"}
            </button>
          </div>
          {cleanupMessage && <p className={styles.cleanupResult} role="status">{cleanupMessage}</p>}
          <p className={styles.cleanupHint}>Active queued/processing jobs are protected. Successful jobs are automatically cleaned up by the updated worker. Cleanup requires localhost development or a configured access key.</p>
        </section>
        <p className={styles.footnote}>Removing a Completed record is permanent and allows that Internal ID to be collected again. Deletion availability depends on your Firestore security rules.</p>
      </div>

      {cleanupOpen && <div className={styles.backdrop}>
        <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="cleanup-heading">
          <div className={styles.dialogHeader}>
            <h2 id="cleanup-heading">Clear old local job files?</h2>
            {!cleanupBusy && <button type="button" className={styles.closeButton} onClick={() => setCleanupOpen(false)} aria-label="Close">×</button>}
          </div>
          <p className={styles.warning}>This permanently deletes local screenshots and terminal job JSON files. It never deletes Firestore records or cancels active jobs.</p>
          <div className={styles.deleteDetails}>
            <strong>{cleanupPreview?.jsonFiles ?? 0} completed/failed/review job JSON files · {cleanupPreview?.imageFiles ?? 0} image files</strong>
            <span>{cleanupPreview?.activeJobs ?? 0} queued or processing jobs will be kept. Unreadable JSON files are kept too.</span>
          </div>
          <label className={styles.confirmLabel}>
            <span>Type <strong>CLEAR FILES</strong> to proceed</span>
            <input value={cleanupConfirmation} onChange={event => setCleanupConfirmation(event.target.value)} autoComplete="off" placeholder="CLEAR FILES" />
          </label>
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} disabled={cleanupBusy} onClick={() => setCleanupOpen(false)}>Cancel</button>
            <button type="button" className={styles.dangerSolid} disabled={cleanupBusy || cleanupConfirmation !== "CLEAR FILES" || ((cleanupPreview?.jsonFiles ?? 0) + (cleanupPreview?.imageFiles ?? 0) === 0)} onClick={deleteQueueArtifacts}>{cleanupBusy ? "Clearing…" : "Clear old files"}</button>
          </div>
        </div>
      </div>}
      {deleteMode && <div className={styles.backdrop}>
        <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="delete-heading">
          <div className={styles.dialogHeader}>
            <h2 id="delete-heading">Permanently delete completed records?</h2>
            {!deleting && <button type="button" className={styles.closeButton} onClick={closeDialog} aria-label="Close">×</button>}
          </div>
          <p className={styles.warning}>This removes records from Firestore, not just the screen. It cannot be undone.</p>
          <div className={styles.deleteDetails}>
            <strong>{countLoading ? "Counting matches…" : `${deleteCount ?? 0} record${deleteCount === 1 ? "" : "s"} ${deleteMode === "selected" ? "selected on this page" : "match the filters"}`}</strong>
            <span>{deleteMode === "filtered" ? filtersSummary(applied) : "Only the selected IDs on the visible page."}</span>
            {deleteMode === "filtered" && <small>A single cleanup deletes at most 2,000 records. Repeat if more remain.</small>}
          </div>
          {deleting ? <p className={styles.progress}>Deleting… {deletedProgress} records removed</p> : <label className={styles.confirmLabel}><span>Type <strong>DELETE</strong> to confirm</span><input value={deleteText} autoComplete="off" autoCapitalize="characters" onChange={event => setDeleteText(event.target.value)} placeholder="DELETE" /></label>}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondaryButton} disabled={deleting} onClick={closeDialog}>Cancel</button>
            <button type="button" className={styles.dangerSolid} disabled={deleteText !== "DELETE" || countLoading || !deleteCount || deleting} onClick={confirmDeletion}>{deleting ? "Deleting…" : "Delete permanently"}</button>
          </div>
        </div>
      </div>}
    </main>
  );
}
