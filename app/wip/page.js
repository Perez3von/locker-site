"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { collection, limit, onSnapshot, orderBy, query, startAfter, where } from "firebase/firestore";
import { db } from "../../lib/firebase";
import styles from "./EmployeeWip.module.css";

const PAGE_SIZE = 50;
const FILTERS = [
  { value: "all", label: "All" },
  { value: "ready", label: "Waiting" },
  { value: "queued", label: "Queued" },
  { value: "processing", label: "Processing" },
  { value: "review", label: "Needs review" },
  { value: "failed", label: "Failed" },
];

function asMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function formatTime(millis) {
  if (!Number.isFinite(millis)) return "Recently added";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(millis);
}

function displayStatus(status) {
  if (status === "queued") return { label: "Queued", detail: "Waiting for the owner to process", tone: "queued" };
  if (status === "processing") return { label: "Processing", detail: "Sign-out in progress", tone: "processing" };
  if (status === "review") return { label: "Needs review", detail: "Awaiting owner verification", tone: "review" };
  if (status === "failed") return { label: "Failed", detail: "Awaiting owner action", tone: "failed" };
  return { label: "Waiting", detail: "Awaiting sign-out", tone: "ready" };
}

function normalizeStatus(value) {
  const normalized = String(value || "ready").toLowerCase();
  return FILTERS.some((entry) => entry.value === normalized) ? normalized : "ready";
}

export default function WipPage() {
  const [page, setPage] = useState({ number: 1, cursor: null, previous: [] });
  const [items, setItems] = useState([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState("loading");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const lastVisibleRef = useRef(null);

  useEffect(() => {
    const constraints = [
      where("status", "==", "wip"),
      orderBy("createdAt", "desc"),
      limit(PAGE_SIZE + 1),
    ];
    if (page.cursor) constraints.push(startAfter(page.cursor));

    const wipQuery = query(collection(db, "items"), ...constraints);
    const unsubscribe = onSnapshot(wipQuery, (snapshot) => {
      const visible = snapshot.docs.slice(0, PAGE_SIZE);
      lastVisibleRef.current = visible.at(-1) || null;
      setHasNext(snapshot.docs.length > PAGE_SIZE);
      setItems(visible.map((document) => {
        const data = document.data();
        return {
          id: document.id,
          internalId: String(data.internalId || document.id),
          signatureName: typeof data.signatureName === "string" ? data.signatureName : "Not assigned",
          automationStatus: normalizeStatus(data.automationStatus),
          createdAt: asMillis(data.createdAt),
        };
      }));
      setError("");
      setLoading(false);
      setConnection(snapshot.metadata.fromCache ? "cached" : "synced");
    }, (cause) => {
      lastVisibleRef.current = null;
      setItems([]);
      setHasNext(false);
      setLoading(false);
      setConnection("error");
      setError(cause?.message || "Unable to load WIP records.");
    });
    return unsubscribe;
  }, [page.cursor]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toUpperCase();
    return items.filter((item) =>
      (filter === "all" || item.automationStatus === filter) &&
      (!term || item.internalId.toUpperCase().includes(term) || item.signatureName.toUpperCase().includes(term))
    );
  }, [items, filter, search]);

  function nextPage() {
    if (!hasNext || !lastVisibleRef.current) return;
    setLoading(true);
    setPage((current) => ({
      number: current.number + 1,
      cursor: lastVisibleRef.current,
      previous: [...current.previous, current.cursor],
    }));
  }

  function previousPage() {
    if (page.number === 1) return;
    setLoading(true);
    setPage((current) => ({
      number: current.number - 1,
      cursor: current.previous.at(-1) || null,
      previous: current.previous.slice(0, -1),
    }));
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link href="/" className="brand">myIST</Link>
          <nav className="nav-tabs" aria-label="Main navigation">
            <Link href="/" className="nav-tab">Collect</Link>
            <Link href="/wip" className="nav-tab active" aria-current="page">WIP</Link>
          </nav>
          <div className="sync-status">
            <span className={`sync-dot ${connection === "synced" ? "online" : ""}`} />
            {connection === "synced" ? "Synced" : connection === "cached" ? "Cached" : connection === "error" ? "Offline" : "Connecting"}
          </div>
        </div>
      </header>

      <div className={styles.shell}>
        <section className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>Live Package queue</p>
            <h1>Work in Progress</h1>
          </div>
          <Link className={styles.collectLink} href="/">+ Collect IDs</Link>
        </section>

        <section className={styles.panel} aria-label="WIP packages">
          <div className={styles.toolbar}>
            <label className={styles.searchWrap}>
              <span className={styles.inputLabel}>Find on this page</span>
              <input
                className={styles.search}
                placeholder="Internal ID or Signed By"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className={styles.filterWrap}>
              <span className={styles.inputLabel}>Status</span>
              <select className={styles.select} value={filter} onChange={(event) => setFilter(event.target.value)}>
                {FILTERS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
              </select>
            </label>
          </div>

          <div className={styles.summary}>
            <span>Page {page.number} · {items.length} record{items.length === 1 ? "" : "s"}</span>
            <span className={styles.readOnly}>View only</span>
          </div>

          {error && <div className={styles.error} role="alert">{error}</div>}
          {loading ? (
            <div className={styles.empty}>Loading packages…</div>
          ) : filteredItems.length === 0 ? (
            <div className={styles.empty}>
              <strong>{items.length ? "No matches on this page" : "Nothing in WIP on this page"}</strong>
              <p>{items.length ? "Try another filter or go to a different page." : "Collected packages will appear here."}</p>
            </div>
          ) : (
            <div className={styles.list}>
              {filteredItems.map((item) => {
                const status = displayStatus(item.automationStatus);
                return (
                  <article className={styles.item} key={item.id}>
                    <div className={styles.mainInfo}>
                      <div className={styles.id}>{item.internalId}</div>
                      <div className={styles.subtext}>Added {formatTime(item.createdAt)}</div>
                      <div className={styles.signedBy}><span>Signed By</span> <strong>{item.signatureName}</strong></div>
                    </div>
                    <div className={styles.statusBlock}>
                      <span className={`${styles.status} ${styles[status.tone]}`}>
                        <span className={styles.statusDot} />{status.label}
                      </span>
                      <span className={styles.statusDetail}>{status.detail}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <div className={styles.pagination}>
            <button type="button" onClick={previousPage} disabled={loading || page.number === 1}>
              ← Previous
            </button>
            <span>Page {page.number}</span>
            <button type="button" onClick={nextPage} disabled={loading || !hasNext}>
              Next →
            </button>
          </div>
          <p className={styles.note}>Showing at most 50 WIP records per page. Search and status filters apply to the current page.</p>
        </section>
      </div>
    </main>
  );
}
