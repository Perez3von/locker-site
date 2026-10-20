"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db, removeWipItem, removeWipItems, updateWipItem, updateWipSignatureName, cancelQueuedWipJob, releaseReviewedWipItem, completeReviewedWipItem, returnFailedWipToWaiting } from "../../lib/firebase";
import styles from "./WipPage.module.css";

const LOCKED_STATUSES = new Set(["queued", "processing", "review"]);
const FILTERS = [
  ["all", "All"],
  ["ready", "Waiting"],
  ["queued", "Queued"],
  ["processing", "Processing"],
  ["failed", "Failed"],
  ["review", "Needs review"],
];

function normalizedId(value) {
  return String(value ?? "").trim().toUpperCase();
}

function millis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function timeLabel(value) {
  if (!Number.isFinite(value)) return "Recently added";
  return `Added ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(value)}`;
}

function dayKey(value) {
  if (!Number.isFinite(value)) return "unknown";
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(value) {
  if (!Number.isFinite(value)) return "Date unavailable";
  const day = new Date(value);
  const now = new Date();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.round((today - start) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString("en-US", { month: "long", day: "numeric", year: day.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}

function statusInfo(item) {
  const status = item.automationStatus;
  if (status === "queued") return { label: "Queued", tone: "queued", description: "Waiting for the worker to begin." };
  if (status === "processing") return { label: "Processing", tone: "processing", description: "The worker is currently handling this item." };
  if (status === "review") return { label: "Needs review", tone: "review", description: "Save may have been attempted. Check the sign-out status in MSPT before any retry." };
  if (status === "failed") return { label: "Failed", tone: "failed", description: "The worker stopped. Review the error and correct the cause before retrying." };
  return { label: "Waiting", tone: "ready", description: "Ready to sign out." };
}

function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (name === "edit") return <svg {...common}><path d="M12 20h9M16 4a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z" /></svg>;
  if (name === "trash") return <svg {...common}><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5" /></svg>;
  if (name === "chevron") return <svg {...common}><path d="m7 10 5 5 5-5" /></svg>;
  if (name === "close") return <svg {...common}><path d="M18 6 6 18M6 6l12 12" /></svg>;
  if (name === "alert") return <svg {...common}><path d="M12 9v4m0 4h.01M10 3.5l-8 14A2 2 0 0 0 3.7 20h16.6a2 2 0 0 0 1.7-2.5l-8-14a2.3 2.3 0 0 0-4 0Z" /></svg>;
  return <svg {...common}><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>;
}

export default function WipPage() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState("");
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editingSignatureId, setEditingSignatureId] = useState(null);
  const [editingSignatureValue, setEditingSignatureValue] = useState("");
  const [signatureBusy, setSignatureBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [queueing, setQueueing] = useState(false);
  const [overrideSignedBy, setOverrideSignedBy] = useState(false);
  const [signoutMethod, setSignoutMethod] = useState("individual");
  const [signedBy, setSignedBy] = useState("");
  const [message, setMessage] = useState(null);
  const [reviewingId, setReviewingId] = useState(null);
  const [reviewTypedId, setReviewTypedId] = useState("");
  const [reviewVerified, setReviewVerified] = useState(false);
  const [reviewOutcome, setReviewOutcome] = useState("not_signed_out");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [cancelingId, setCancelingId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [returningId, setReturningId] = useState(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setCurrentTime(Date.now()), 30000); return () => clearInterval(timer); }, []);

  // A dedicated WIP listener includes failure details without modifying the
  // app's shared Firebase helpers or the separate sign-out worker.
  useEffect(() => {
    const wipQuery = query(collection(db, "items"), where("status", "==", "wip"), orderBy("createdAt", "desc"));
    return onSnapshot(wipQuery, { includeMetadataChanges: true }, snapshot => {
      setItems(snapshot.docs.map(document => {
        const data = document.data();
        return {
          documentId: document.id,
          internalId: normalizedId(data.internalId || document.id),
          createdAt: millis(data.createdAt),
          automationStatus: String(data.automationStatus || "ready").toLowerCase(),
          automationMethod: data.automationMethod === "batch" ? "batch" : "individual",
          automationBatchIds: Array.isArray(data.automationBatchIds) ? data.automationBatchIds : null,
          automationError: typeof data.automationError === "string" ? data.automationError : "",
          automationStage: typeof data.automationStage === "string" ? data.automationStage : "",
          automationJobId: typeof data.automationJobId === "string" ? data.automationJobId : "",
          automationUpdatedAt: millis(data.automationUpdatedAt),
          automationStartedAt: millis(data.automationStartedAt),
          signatureName: typeof data.signatureName === "string"
            ? (data.signatureName.trim() || "Name missing") : "RETAG",
        };
      }));
      setConnected(!snapshot.metadata.fromCache);
      setConnectionError("");
      setLoading(false);
    }, error => {
      console.error("WIP listener failed:", error);
      setConnected(false);
      setConnectionError(error?.message || "Could not load WIP items.");
      setLoading(false);
    });
  }, []);

  // Realtime worker updates remove newly locked/completed items from selection.
  useEffect(() => {
    const allowed = new Set(items.filter(item => !LOCKED_STATUSES.has(item.automationStatus)).map(item => item.internalId));
    setSelected(current => {
      const next = new Set([...current].filter(id => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
    if (editingId && !allowed.has(editingId)) {
      setEditingId(null);
      setEditingValue("");
    }
    if (reviewingId && !items.some(item => item.internalId === reviewingId && item.automationStatus === "review")) {
      setReviewingId(null);
      setReviewTypedId("");
      setReviewVerified(false);
    }
    if (editingSignatureId && !allowed.has(editingSignatureId)) {
      setEditingSignatureId(null);
      setEditingSignatureValue("");
    }
  }, [items, editingId, editingSignatureId, reviewingId]);

  const counts = useMemo(() => {
    const counts = { all: items.length, ready: 0, queued: 0, processing: 0, failed: 0, review: 0 };
    for (const item of items) counts[item.automationStatus in counts ? item.automationStatus : "ready"] += 1;
    return counts;
  }, [items]);

  const visibleItems = useMemo(() => items.filter(item => filter === "all" || (filter === "ready" ? !["queued", "processing", "review", "failed"].includes(item.automationStatus) : item.automationStatus === filter)), [items, filter]);

  const visibleSelectable = useMemo(() => visibleItems.filter(item => !LOCKED_STATUSES.has(item.automationStatus)), [visibleItems]);
  const selectedItems = useMemo(() => items.filter(item => selected.has(item.internalId)), [items, selected]);
  const selectedNames = useMemo(() => [...new Set(selectedItems.map(item => item.signatureName))], [selectedItems]);
  const batchRequiresOverride = signoutMethod === "batch" && selectedNames.length > 1;
  const batchSelectionInvalid = signoutMethod === "batch" && (selected.size < 1 || selected.size > 30);
  const allVisibleSelected = visibleSelectable.length > 0 && visibleSelectable.every(item => selected.has(item.internalId));

  const groups = useMemo(() => {
    const map = new Map();
    for (const item of visibleItems) {
      const key = dayKey(item.createdAt);
      if (!map.has(key)) map.set(key, { key, timestamp: item.createdAt, items: [] });
      map.get(key).items.push(item);
    }
    return [...map.values()];
  }, [visibleItems]);

  const busy = !connected || queueing || removing || removingId !== null || editBusy || signatureBusy || reviewBusy || cancelingId !== null || retryingId !== null || returningId !== null;

  function notify(text, kind = "success") {
    setMessage({ text, kind });
  }

  function toggleSelection(id) {
    if (!items.some(item => item.internalId === id && !LOCKED_STATUSES.has(item.automationStatus))) return;
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected(current => {
      const next = new Set(current);
      for (const item of visibleSelectable) {
        if (allVisibleSelected) next.delete(item.internalId);
        else next.add(item.internalId);
      }
      return next;
    });
  }

  function toggleDetails(id) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function retryFailed(item) {
    if (busy || item.automationStatus !== "failed") return;
    setRetryingId(item.internalId);
    setMessage(null);
    try {
      const response = await fetch("/api/automation/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [item.internalId], method: "individual" }),
      });
      const data = await response.json();
      if (!response.ok || !data.queued) {
        throw new Error(data?.error || data?.skippedReasons?.[item.internalId] || "Item is no longer available to queue.");
      }
      notify(`${item.internalId} queued again with its saved Signed By value.`);
    } catch (error) {
      notify(error?.message || "Could not retry sign-out.", "error");
    } finally {
      setRetryingId(null);
    }
  }

  async function returnFailed(item) {
    if (busy || item.automationStatus !== "failed") return;
    setReturningId(item.internalId);
    try {
      await returnFailedWipToWaiting(item.internalId);
      notify(`${item.internalId} returned to Waiting. No new job was submitted.`);
    } catch (error) {
      notify(error?.message || "Could not return the item to Waiting.", "error");
    } finally {
      setReturningId(null);
    }
  }

  async function cancelQueued(item) {
    if (busy || item.automationStatus !== "queued") return;
    setCancelingId(item.internalId);
    try {
      await cancelQueuedWipJob(item.internalId);
      notify(item.automationMethod === "batch" ? `The queued batch containing ${item.internalId} was canceled for all its members.` : `${item.internalId} removed from the queue. It can be submitted again.`);
    } catch (error) {
      notify(error?.message || "Could not cancel queued job.", "error");
    } finally {
      setCancelingId(null);
    }
  }

  function openReview(item) {
    setReviewingId(item.internalId);
    setReviewTypedId("");
    setReviewVerified(false);
    setReviewOutcome("not_signed_out");
    setExpanded(current => new Set([...current, item.internalId]));
  }

  function closeReview() {
    if (reviewBusy) return;
    setReviewingId(null);
    setReviewTypedId("");
    setReviewVerified(false);
  }

  async function resolveReview(item) {
    if (busy || item.automationStatus !== "review" || reviewingId !== item.internalId) return;
    setReviewBusy(true);
    try {
      if (reviewOutcome === "signed_out") {
        await completeReviewedWipItem(item.internalId, reviewTypedId, reviewVerified);
        notify(`${item.internalId} moved to Completed as manually verified in MSPT.`);
      } else {
        await releaseReviewedWipItem(item.internalId, reviewTypedId, reviewVerified);
        notify(`${item.internalId} returned to Waiting after verification in MSPT. No new job was submitted.`);
      }
      setReviewingId(null);
      setReviewTypedId("");
      setReviewVerified(false);
    } catch (error) {
      notify(error?.message || "Could not release the item.", "error");
    } finally {
      setReviewBusy(false);
    }
  }

  async function signOutSelected() {
    if (busy || !selected.size) return;
    if (batchSelectionInvalid) {
      notify("Batch requires 1–30 selected Internal IDs.", "error");
      return;
    }
    if (batchRequiresOverride && !overrideSignedBy) {
      notify("These IDs have different Signed By values. Enable override to use one batch signature.", "error");
      return;
    }
    const signatureField = signedBy.trim();
    if (overrideSignedBy && (!signatureField || signatureField.length > 250)) {
      notify("Enter a Signed By override (1–250 characters).", "error");
      return;
    }
    setQueueing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/automation/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // By default, the API reads each item's Signed By name from Firestore.
        // Include an override only when the user explicitly chooses one.
        body: JSON.stringify({
          ids: [...selected],
          method: signoutMethod,
          ...(overrideSignedBy ? { signatureField } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not queue sign-outs.");
      const accepted = Number(data.count) || 0;
      const skipped = Array.isArray(data.skipped) ? data.skipped.length : 0;
      if (accepted > 0) setSelected(new Set());
      notify(accepted > 0 ? `${accepted} item${accepted === 1 ? "" : "s"} queued for ${signoutMethod === "batch" ? "one batch signature" : "individual sign-out"}${skipped ? `; ${skipped} skipped because they are unavailable or already processing` : ""}.` : "No items were queued. They may have changed status. Refresh and review the list.", accepted > 0 ? "success" : "error");
    } catch (error) {
      notify(error?.message || "Could not queue selected items.", "error");
    } finally {
      setQueueing(false);
    }
  }

  async function removeOne(id) {
    if (busy) return;
    const item = items.find(value => value.internalId === id);
    if (!item || LOCKED_STATUSES.has(item.automationStatus)) return;
    setRemovingId(id);
    try {
      await removeWipItem(id);
      setSelected(current => { const next = new Set(current); next.delete(id); return next; });
      notify(`${id} removed.`);
    } catch (error) {
      notify(error?.message || "Could not remove item.", "error");
    } finally {
      setRemovingId(null);
    }
  }

  async function removeSelected() {
    if (busy || !selected.size) return;
    const allowed = new Set(items.filter(item => !LOCKED_STATUSES.has(item.automationStatus)).map(item => item.internalId));
    const ids = [...selected].filter(id => allowed.has(id));
    if (!ids.length) return;
    setRemoving(true);
    try {
      await removeWipItems(ids);
      setSelected(new Set());
      notify(`${ids.length} item${ids.length === 1 ? "" : "s"} removed.`);
    } catch (error) {
      notify(error?.message || "Could not remove selected items.", "error");
    } finally {
      setRemoving(false);
    }
  }

  function beginSignatureEdit(item) {
    if (busy || LOCKED_STATUSES.has(item.automationStatus)) return;
    setEditingId(null);
    setEditingValue("");
    setEditingSignatureId(item.internalId);
    setEditingSignatureValue(item.signatureName === "Name missing" ? "" : item.signatureName);
  }

  function cancelSignatureEdit() {
    if (signatureBusy) return;
    setEditingSignatureId(null);
    setEditingSignatureValue("");
  }

  async function saveSignatureEdit() {
    if (!editingSignatureId || signatureBusy || !connected) return;
    const name = editingSignatureValue.trim();
    if (!name || name.length > 250) {
      notify("Signed By must be 1–250 characters.", "error");
      return;
    }
    setSignatureBusy(true);
    try {
      await updateWipSignatureName(editingSignatureId, name);
      notify(`Signed By for ${editingSignatureId} updated to ${name}.`);
      setEditingSignatureId(null);
      setEditingSignatureValue("");
    } catch (error) {
      notify(error?.message || "Could not update Signed By.", "error");
    } finally {
      setSignatureBusy(false);
    }
  }

  function beginEdit(item) {
    if (busy || LOCKED_STATUSES.has(item.automationStatus)) return;
    setEditingSignatureId(null);
    setEditingSignatureValue("");
    setEditingId(item.internalId);
    setEditingValue(item.internalId);
  }

  function cancelEdit() {
    if (editBusy) return;
    setEditingId(null);
    setEditingValue("");
  }

  async function saveEdit() {
    if (!editingId || editBusy) return;
    const newId = normalizedId(editingValue);
    if (!newId) {
      notify("Enter an Internal ID.", "error");
      return;
    }
    if (newId === editingId) { cancelEdit(); return; }
    const oldId = editingId;
    setEditBusy(true);
    try {
      await updateWipItem(oldId, newId);
      setSelected(current => {
        if (!current.has(oldId)) return current;
        const next = new Set(current);
        next.delete(oldId);
        next.add(newId);
        return next;
      });
      notify(`${oldId} changed to ${newId}.`);
      setEditingId(null);
      setEditingValue("");
    } catch (error) {
      notify(error?.message || "Could not update item.", "error");
    } finally {
      setEditBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">Locker</Link>
          <nav className="nav-tabs" aria-label="Main navigation">
            <Link href="/" className="nav-tab">Collect</Link>
            <Link href="/wip" className="nav-tab active" aria-current="page">WIP{items.length > 0 && <span className="nav-count">{items.length}</span>}</Link>
            <Link href="/completed" className="nav-tab">Completed</Link>
          </nav>
          <div className="sync-status"><span className={`sync-dot ${connected ? "online" : ""}`} />{connected ? "Synced" : "Offline"}</div>
        </div>
      </header>

      <div className={styles.page}>
        <div className={styles.heading}>
          <div>
            <div className={styles.eyebrow}>Package management</div>
            <h1>Work in Progress</h1>
            <p>Review items, track sign-outs, and resolve anything that needs attention.</p>
          </div>
          <div className={styles.total}><span>Total in WIP</span><strong>{items.length}</strong></div>
        </div>

        <section className={styles.panel} aria-label="WIP items">
          <div className={styles.filterBar} role="group" aria-label="Filter by processing status">
            {FILTERS.map(([value, label]) => (
              <button key={value} type="button" className={`${styles.filterButton} ${filter === value ? styles.filterActive : ""}`} onClick={() => setFilter(value)} aria-pressed={filter === value}>
                {label}<span className={styles.filterCount}>{counts[value]}</span>
              </button>
            ))}
          </div>

          <div className={styles.selectionBar}>
            <label className={styles.selectAll}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!visibleSelectable.length || busy} />
              <span>{allVisibleSelected ? "Deselect visible" : "Select visible"}</span>
            </label>
            <span className={styles.selectionCount}>{selected.size > 0 ? `${selected.size} selected` : `${visibleItems.length} shown`}</span>
          </div>

          {selected.size > 0 && (
            <div className={styles.batchPanel}>
              <div className={styles.signedByGroup}>
                <fieldset className={styles.methodSelector} disabled={busy}>
                  <legend>Sign-out method</legend>
                  <label className={`${styles.methodOption} ${signoutMethod === "individual" ? styles.methodActive : ""}`}>
                    <input type="radio" name="signout-method" value="individual" checked={signoutMethod === "individual"} onChange={() => setSignoutMethod("individual")}/>
                    <span><strong>Individual</strong><small>Search Package · one Save per ID</small></span>
                  </label>
                  <label className={`${styles.methodOption} ${signoutMethod === "batch" ? styles.methodActive : ""}`}>
                    <input type="radio" name="signout-method" value="batch" checked={signoutMethod === "batch"} onChange={() => setSignoutMethod("batch")}/>
                    <span><strong>Batch</strong><small>Get Signature · one Save for all selected IDs</small></span>
                  </label>
                </fieldset>
                <div className={styles.assignedInfo}>
                  {signoutMethod === "batch" ? "One Signed By name applies to the selected IDs (1–30). A single ID may include multiple tracking numbers." : "Each item uses its own Signed By value from Collect."}
                </div>
                {batchRequiresOverride && !overrideSignedBy && (
                  <div className={styles.batchWarning} role="alert">Selected items have different Signed By names. Enable the override below before using Batch.</div>
                )}
                {batchSelectionInvalid && (
                  <div className={styles.batchWarning} role="status">Batch supports 1–30 selected Internal IDs.</div>
                )}
                <label className={styles.overrideToggle}>
                  <input
                    type="checkbox"
                    checked={overrideSignedBy}
                    onChange={event => setOverrideSignedBy(event.target.checked)}
                    disabled={busy}
                  />
                  Override Signed By for selected items
                </label>
                {overrideSignedBy && (
                  <label className={styles.signedBy}>
                    <span>Signed By override</span>
                    <input
                      value={signedBy}
                      onChange={event => setSignedBy(event.target.value)}
                      placeholder="RETAG, RTS, or recipient name"
                      maxLength={250}
                      disabled={busy}
                      autoComplete="off"
                      autoFocus
                    />
                  </label>
                )}
              </div>
              <div className={styles.batchActions}>
                <button type="button" className={styles.primaryButton} onClick={signOutSelected} disabled={busy || batchSelectionInvalid || (batchRequiresOverride && !overrideSignedBy) || (overrideSignedBy && !signedBy.trim())}>{queueing ? "Queueing…" : signoutMethod === "batch" ? `Batch Sign Out ${selected.size}` : `Sign Out ${selected.size}`}</button>
                <button type="button" className={styles.dangerButton} onClick={removeSelected} disabled={busy}>{removing ? "Removing…" : `Remove ${selected.size}`}</button>
              </div>
            </div>
          )}

          {message && (
            <div className={`${styles.message} ${message.kind === "error" ? styles.messageError : styles.messageSuccess}`} role={message.kind === "error" ? "alert" : "status"}>
              <span>{message.text}</span>
              <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss message"><Icon name="close" size={17}/></button>
            </div>
          )}
          {connectionError && <div className={`${styles.message} ${styles.messageError}`} role="alert">Live connection unavailable: {connectionError}</div>}
          {!connected && !loading && !connectionError && <div className={`${styles.message} ${styles.messageError}`} role="status">Offline or reconnecting — you can view WIP items, but changes are disabled until synced.</div>}

          {loading ? <div className={styles.empty}><strong>Loading WIP…</strong><span>Connecting to your collection.</span></div> : items.length === 0 ? (
            <div className={styles.empty}><Icon name="package" size={36}/><strong>Nothing waiting</strong><span>IDs sent from Collect will appear here.</span><Link href="/" className={styles.emptyLink}>Go to Collect</Link></div>
          ) : visibleItems.length === 0 ? (
            <div className={styles.empty}><strong>No items in this status</strong><span>Choose another filter to see the rest of your list.</span></div>
          ) : (
            <div className={styles.groups}>
              {groups.map(group => (
                <section key={group.key} className={styles.group}>
                  <div className={styles.groupTitle}><h2>{dayLabel(group.timestamp)}</h2><span>{group.items.length}</span></div>
                  <div className={styles.list}>
                    {group.items.map(item => {
                      const id = item.internalId;
                      const info = statusInfo(item);
                      const locked = LOCKED_STATUSES.has(item.automationStatus);
                      const isEditing = editingId === id;
                      const activeMinutes = item.automationUpdatedAt
                        ? Math.max(0, Math.floor((currentTime - item.automationUpdatedAt) / 60000)) : null;
                      const queuedLong = item.automationStatus === "queued" && activeMinutes !== null && activeMinutes >= 3;
                      const hasDetails = Boolean(item.automationError) || ["review", "failed", "queued", "processing"].includes(item.automationStatus);
                      const detailsOpen = expanded.has(id);
                      return (
                        <div key={item.documentId || id} className={`${styles.item} ${selected.has(id) ? styles.itemSelected : ""}`}>
                          <div className={styles.itemRow}>
                            <label className={styles.itemCheck} title={locked ? "Item locked while processing or awaiting review" : `Select ${id}`}>
                              <input type="checkbox" checked={selected.has(id)} disabled={locked || busy} onChange={() => toggleSelection(id)} aria-label={`Select ${id}`} />
                            </label>
                            <div className={styles.itemIdentity}>
                              {isEditing ? (
                                <input className={styles.editInput} aria-label={`Edit ID ${id}`} value={editingValue} onChange={event => setEditingValue(event.target.value)} onKeyDown={event => { if (event.key === "Enter") saveEdit(); if (event.key === "Escape") cancelEdit(); }} maxLength={120} autoFocus disabled={editBusy} />
                              ) : <strong title={id}>{id}</strong>}
                              <span>{timeLabel(item.createdAt)}</span>
                              {editingSignatureId === id ? (
                                <div className={styles.signatureEdit}>
                                  <label className={styles.signatureEditLabel} htmlFor={`signature-${id}`}>Signed By</label>
                                  <input
                                    id={`signature-${id}`}
                                    aria-label={`Signed By for ${id}`}
                                    value={editingSignatureValue}
                                    onChange={event => setEditingSignatureValue(event.target.value)}
                                    onKeyDown={event => {
                                      if (event.key === "Enter") saveSignatureEdit();
                                      if (event.key === "Escape") cancelSignatureEdit();
                                    }}
                                    maxLength={250}
                                    disabled={signatureBusy}
                                    autoFocus
                                  />
                                  <div className={styles.signatureEditActions}>
                                    <button type="button" className={styles.saveEdit} disabled={signatureBusy || !editingSignatureValue.trim()} onClick={saveSignatureEdit}>Save name</button>
                                    <button type="button" className={styles.cancelEdit} disabled={signatureBusy} onClick={cancelSignatureEdit}>Cancel</button>
                                  </div>
                                </div>
                              ) : (
                                <div className={styles.signatureInline}>
                                  <span className={styles.signatureLabel} title={`Signed By: ${item.signatureName}`}>Signed By: {item.signatureName}{item.automationMethod === "batch" && LOCKED_STATUSES.has(item.automationStatus) ? ` · Batch (${item.automationBatchIds?.length || "?"} IDs)` : ""}</span>
                                  {!locked && !isEditing && (
                                    <button
                                      type="button"
                                      className={styles.signatureEditButton}
                                      disabled={busy}
                                      onClick={() => beginSignatureEdit(item)}
                                      aria-label={`Change Signed By for ${id}`}
                                      title="Correct Signed By"
                                    ><Icon name="edit" size={14}/></button>
                                  )}
                                </div>
                              )}
                            </div>
                            <div className={styles.itemStatus}>
                              <span className={`${styles.statusPill} ${styles[info.tone]}`}><span className={styles.statusDot}/>{info.label}</span>
                              {item.automationStatus === "queued" && <>
                                <small className={styles.statusTiming}>{activeMinutes === null ? "Awaiting worker" : `Waiting ${activeMinutes}m`}{queuedLong ? " · Check worker" : ""}</small>
                                <button type="button" className={styles.rowQuickAction} disabled={busy} onClick={() => cancelQueued(item)}>{cancelingId === id ? "Canceling…" : item.automationMethod === "batch" ? "Cancel batch" : "Cancel job"}</button>
                              </>}
                              {item.automationStatus === "processing" && <small className={styles.statusTiming} title={item.automationStage || "Worker running"}>{item.automationStage || "Worker running"}</small>}
                              {item.automationStatus === "failed" && <button type="button" className={styles.rowQuickAction} disabled={busy} onClick={() => returnFailed(item)}>Return to Waiting</button>}
                              {item.automationStatus === "review" && <button type="button" className={styles.rowQuickAction} disabled={busy} onClick={() => openReview(item)}>Resolve review</button>}
                            </div>
                            <div className={styles.itemActions}>
                              {isEditing ? (
                                <><button type="button" className={styles.saveEdit} disabled={editBusy} onClick={saveEdit}>Save</button><button type="button" className={styles.cancelEdit} disabled={editBusy} onClick={cancelEdit}>Cancel</button></>
                              ) : (
                                <>
                                  {hasDetails && <button type="button" className={`${styles.iconButton} ${styles.detailsButton}`} onClick={() => toggleDetails(id)} aria-expanded={detailsOpen} aria-label={`${detailsOpen ? "Hide" : "Show"} details for ${id}`} title="Details"><span className={`${styles.chevron} ${detailsOpen ? styles.chevronUp : ""}`}><Icon name="chevron" /></span></button>}
                                  <button type="button" className={styles.iconButton} disabled={locked || busy || editingSignatureId === id} onClick={() => beginEdit(item)} aria-label={`Edit ${id}`} title={locked ? "Unavailable while processing or awaiting review" : "Edit ID"}><Icon name="edit" /></button>
                                  <button type="button" className={`${styles.iconButton} ${styles.trashButton}`} disabled={locked || busy} onClick={() => removeOne(id)} aria-label={`Remove ${id}`} title={locked ? "Unavailable while processing or awaiting review" : "Remove ID"}><Icon name="trash" /></button>
                                </>
                              )}
                            </div>
                          </div>
                          {hasDetails && detailsOpen && (
                            <div className={styles.itemDetails}>
                              <div className={styles.detailTitle}><Icon name="alert" size={16}/>{info.label}</div>
                              <p>{info.description}</p>
                              {item.automationJobId && <p className={styles.jobMeta}><strong>Job:</strong> <code>{item.automationJobId}</code></p>}
                              {item.automationUpdatedAt && <p className={styles.jobMeta}><strong>Last update:</strong> {new Date(item.automationUpdatedAt).toLocaleString()}</p>}
                              {item.automationStatus === "processing" && item.automationStage && <p className={styles.jobMeta}><strong>Stage:</strong> {item.automationStage}</p>}
                              {queuedLong && <p className={styles.queueWarning}>This job has been queued for at least 3 minutes. Check whether <code>npm run worker</code> is running. You can cancel while the worker has not claimed the job.</p>}
                              {item.automationError && <p className={styles.errorText}>{item.automationError}</p>}
                              {item.automationStatus === "queued" && (
                                <div className={styles.recoveryActions}>
                                  <p>Not yet started. Canceling is permitted only while this job is still queued.</p>
                                  <button type="button" className={styles.secondaryAction} onClick={() => cancelQueued(item)} disabled={busy}>
                                    {cancelingId === id ? "Canceling…" : item.automationMethod === "batch" ? "Cancel entire queued batch" : "Cancel queued job"}
                                  </button>
                                </div>
                              )}
                              {item.automationStatus === "processing" && (
                                <p className={styles.reviewHint}>The worker has claimed this job. It cannot be canceled safely from the WIP page.</p>
                              )}
                              {item.automationStatus === "failed" && (
                                <div className={styles.recoveryActions}>
                                  <p className={styles.reviewHint}>Fix the cause first. You can edit Signed By or the ID, then retry here or select multiple failed items.</p>
                                  <button type="button" className={styles.secondaryAction} onClick={() => retryFailed(item)} disabled={busy}>
                                    {retryingId === id ? "Queueing…" : "Retry sign-out"}
                                  </button>
                                  <button type="button" className={styles.secondaryAction} onClick={() => returnFailed(item)} disabled={busy}>
                                    {returningId === id ? "Returning…" : "Return to Waiting (no sign-out)"}
                                  </button>
                                </div>
                              )}
                              {item.automationStatus === "review" && (
                                <div className={styles.reviewResolution}>
                                  <p className={styles.reviewHint}>Save may have been attempted. Verify this Internal ID directly in MSPT. Do not retry a package that is already signed out.</p>
                                  {reviewingId !== id ? (
                                    <button type="button" className={styles.secondaryAction} onClick={() => openReview(item)} disabled={busy}>Return to Waiting / Mark Completed</button>
                                  ) : (
                                    <div className={styles.reviewForm}>
                                      <fieldset className={styles.reviewOutcomes} disabled={reviewBusy}>
                                        <legend>What does MSPT show for this package?</legend>
                                        <label><input type="radio" name={`review-outcome-${id}`} value="not_signed_out" checked={reviewOutcome === "not_signed_out"} onChange={() => { setReviewOutcome("not_signed_out"); setReviewVerified(false); }}/> Not signed out — return to Waiting</label>
                                        <label><input type="radio" name={`review-outcome-${id}`} value="signed_out" checked={reviewOutcome === "signed_out"} onChange={() => { setReviewOutcome("signed_out"); setReviewVerified(false); }}/> Signed out — move to Completed</label>
                                      </fieldset>
                                      <label className={styles.reviewConfirmCheck}>
                                        <input type="checkbox" checked={reviewVerified} onChange={event => setReviewVerified(event.target.checked)} disabled={reviewBusy}/>
                                        I personally checked MSPT and confirmed this package is <strong>{reviewOutcome === "signed_out" ? "SIGNED OUT" : "NOT signed out"}</strong>.
                                      </label>
                                      <label className={styles.reviewEntry}>
                                        Enter Internal ID <strong>{id}</strong> to confirm this resolution
                                        <input value={reviewTypedId} onChange={event => setReviewTypedId(event.target.value)} placeholder={id} autoCapitalize="characters" autoComplete="off" disabled={reviewBusy}/>
                                      </label>
                                      <div className={styles.recoveryActions}>
                                        <button type="button" className={styles.warningAction} onClick={() => resolveReview(item)} disabled={busy || !reviewVerified || normalizedId(reviewTypedId) !== id}>{reviewBusy ? "Saving…" : reviewOutcome === "signed_out" ? "Confirm signed out — move to Completed" : "Confirm not signed out — return to Waiting"}</button>
                                        <button type="button" className={styles.secondaryAction} onClick={closeReview} disabled={reviewBusy}>Cancel</button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
