"use client";



import { useOfflineRuntime } from "../lib/useOfflineRuntime";
import { notifyQueueChanged, queueWip, pendingEntries, readStoredDraft, writeStoredDraft } from "../lib/offlineQueue";

import BarcodeCamera from "./components/BarcodeCamera";

import controls from "./CollectControls.module.css";



import {

  useEffect,

  useMemo,

  useRef,

  useState,

} from "react";



import {


  subscribeToWip,

} from "../lib/firebase";



const DRAFT_CACHE_KEY = "locker-collect-draft-v1";


const DRAFT_SAVE_DEBOUNCE = 400;



function normalizeId(value) {

  return String(value || "").trim().toUpperCase();

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



function readDraft() {

  const empty = { data: [] };

  try {

    const raw = localStorage.getItem(DRAFT_CACHE_KEY);

    if (!raw) return empty;

    const cache = JSON.parse(raw);

    if (

      !Array.isArray(cache.data)

    ) {

      localStorage.removeItem(DRAFT_CACHE_KEY);

      return empty;

    }

    // Older drafts contain only the ID array. Keep them intact.

    return { data: cache.data, savedAt: Number(cache.savedAt || 0) };

  } catch {

    return empty;

  }

}



function writeDraft(data) {

  try {

    localStorage.setItem(

      DRAFT_CACHE_KEY,

      JSON.stringify({ savedAt: Date.now(), data })

    );

  } catch (error) {

    console.error("Draft save failed:", error);

  }

}



function UploadIcon() {

  return (

    <svg

      viewBox="0 0 24 24"

      fill="none"

      aria-hidden="true"

    >

      <path

        d="M12 16V4M7.5 8.5 12 4l4.5 4.5"

        stroke="currentColor"

        strokeWidth="1.8"

        strokeLinecap="round"

        strokeLinejoin="round"

      />



      <path

        d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"

        stroke="currentColor"

        strokeWidth="1.8"

        strokeLinecap="round"

      />

    </svg>

  );

}



function ScanIcon() {

  return (

    <svg

      viewBox="0 0 24 24"

      fill="none"

      aria-hidden="true"

    >

      <path

        d="M5 8V5h3M16 5h3v3M19 16v3h-3M8 19H5v-3"

        stroke="currentColor"

        strokeWidth="1.8"

        strokeLinecap="round"

      />



      <path

        d="M8 12h8"

        stroke="currentColor"

        strokeWidth="1.8"

        strokeLinecap="round"

      />

    </svg>

  );

}



export default function Home() {

  const inputRef = useRef(null);



  const [input, setInput] = useState("");

  const [signatureName, setSignatureName] = useState("");

  const [cameraOpen, setCameraOpen] = useState(false);

  const [rescanId, setRescanId] = useState(null);

  const [editId, setEditId] = useState(null);

  const [editValue, setEditValue] = useState("");

  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const [draftIds, setDraftIds] = useState([]);

  const [wipItems, setWipItems] = useState([]);
  const { online, pending, lastSync, storageError, refresh } = useOfflineRuntime();



  const [draftLoaded, setDraftLoaded] = useState(false);

  const [connected, setConnected] = useState(false);

  const [sending, setSending] = useState(false);



  const [message, setMessage] = useState("");

  const [messageType, setMessageType] =

    useState("success");



  /* =======================================================

     INITIALIZE

  ======================================================= */



  useEffect(() => {
    let active = true;
    (async () => {
      const local = readDraft();
      let stored = null;
      try { stored = await readStoredDraft(); } catch (error) { console.warn("Draft backup unavailable:", error); }
      if (!active) return;
      // Prefer the newest saved snapshot; keep existing drafts from old versions.
      const newest = stored && stored.savedAt > (local.savedAt || 0) ? stored.ids : local.data;
      let pendingIds = [];
      try { pendingIds = (await pendingEntries()).map((entry) => entry.internalId); }
      catch (error) { console.warn("Could not inspect pending IDs:", error); }
      if (!active) return;
      setDraftIds((Array.isArray(newest) ? newest : []).filter((id) => !pendingIds.includes(id)));
      setDraftLoaded(true);
    })();

    const unsubscribe = subscribeToWip(

      (items) => {

        setWipItems(items);

        setConnected(true);

      },

      () => {

        setConnected(false);

      }

    );



    return () => { active = false; unsubscribe(); };

  }, []);



  /* =======================================================

     SAVE LOCAL DRAFT

  ======================================================= */



  useEffect(() => {

    if (!draftLoaded) return;



    // Synchronous mirror protects the last scan if the app closes immediately.
    writeDraft(draftIds);
    const timer = setTimeout(() => {
      void writeStoredDraft(draftIds).catch((error) => {
        console.warn("IndexedDB draft backup failed:", error);
      });
    }, DRAFT_SAVE_DEBOUNCE);



    return () => clearTimeout(timer);

  }, [draftIds, draftLoaded]);



  useEffect(() => {

    setSelectedIds((current) => {

      const allowed = new Set(draftIds);

      const next = new Set([...current].filter((id) => allowed.has(id)));

      return next.size === current.size ? current : next;

    });

  }, [draftIds]);



  const wipIdSet = useMemo(

    () =>

      new Set(

        wipItems.map((item) => item.internalId)

      ),

    [wipItems]

  );



  /* =======================================================

     REMOVE IDS FROM LOCAL DRAFT IF ANOTHER USER SENDS THEM

     TO WIP

  ======================================================= */



  useEffect(() => {

    if (!connected) return;



    setDraftIds((current) =>

      current.filter((id) => !wipIdSet.has(id))

    );

  }, [wipIdSet, connected]);



  function showMessage(

    text,

    type = "success"

  ) {

    setMessage(text);

    setMessageType(type);

  }



  /* =======================================================

     STAGE IDS

  ======================================================= */



  function stageIds(text) {

    const parsed = parseIds(text);



    if (parsed.length === 0) return;



    const existingDraft = new Set(draftIds);



    const added = [];



    let alreadyWip = 0;

    let alreadyDraft = 0;



    parsed.forEach((id) => {

      if (wipIdSet.has(id)) {

        alreadyWip++;

        return;

      }



      if (existingDraft.has(id)) {

        alreadyDraft++;

        return;

      }



      existingDraft.add(id);

      added.push(id);

    });



    if (added.length > 0) {

      setDraftIds((current) => [

        ...current,

        ...added,

      ]);

    }



    const parts = [];



    if (added.length) {

      parts.push(`${added.length} ready`);

    }



    if (alreadyWip) {

      parts.push(

        `${alreadyWip} already in WIP`

      );

    }



    if (alreadyDraft) {

      parts.push(

        `${alreadyDraft} already staged`

      );

    }



    showMessage(

      parts.join(" · ") || "No new IDs"

    );

  }



  function handleStage() {

    if (!input.trim()) return;



    stageIds(input);



    setInput("");



    requestAnimationFrame(() => {

      inputRef.current?.focus();

    });

  }



  /* =======================================================

     SCANNER ENTER

  ======================================================= */



  function handleKeyDown(event) {

    if (

      event.key !== "Enter" ||

      event.shiftKey

    ) {

      return;

    }



    const parsed = parseIds(input);



    if (parsed.length === 1) {

      event.preventDefault();



      stageIds(input);

      setInput("");

    }

  }



  function acceptCameraId(value) {

    const id = normalizeId(value);

    if (!id || /[\s,;]/.test(id)) return false;

    if (rescanId) {

      if (id !== rescanId && (draftIds.includes(id) || wipIdSet.has(id))) {

        showMessage(`${id} already exists`, "error");

        return false;

      }

      setDraftIds((current) => current.map((v) => v === rescanId ? id : v));

      setSelectedIds((current) => {

        if (!current.has(rescanId)) return current;

        const next = new Set(current);

        next.delete(rescanId);

        next.add(id);

        return next;

      });

      setRescanId(null);

      showMessage(`${id} verified`);

      return true;

    }

    if (draftIds.includes(id) || wipIdSet.has(id)) {

      showMessage(`${id} already exists`, "error");

      return false;

    }

    setDraftIds((current) => [...current, id]);

    showMessage(`${id} added`);

    return true;

  }



  function saveEdit() {

    const id = normalizeId(editValue);

    if (!id || /[\s,;]/.test(id)) {

      showMessage("Enter one valid ID", "error");

      return;

    }

    if (id !== editId && (draftIds.includes(id) || wipIdSet.has(id))) {

      showMessage(`${id} already exists`, "error");

      return;

    }

    setDraftIds((current) => current.map((v) => v === editId ? id : v));

    setSelectedIds((current) => {

      if (!current.has(editId)) return current;

      const next = new Set(current);

      next.delete(editId);

      next.add(id);

      return next;

    });

    setEditId(null);

    showMessage("ID updated");

  }



  function removeSelectedDraft() {

    setDraftIds((current) => current.filter((id) => !selectedIds.has(id)));

    setSelectedIds(new Set());

  }



  function removeDraft(id) {

    setSelectedIds((current) => { const next = new Set(current); next.delete(id); return next; });

    setDraftIds((current) =>

      current.filter(

        (item) => item !== id

      )

    );

  }



  function clearDraft() {

    setDraftIds([]);

    setSelectedIds(new Set());

    setInput("");



    showMessage("Collection cleared");



    requestAnimationFrame(() => {

      inputRef.current?.focus();

    });

  }



  /* =======================================================

     SEND TO FIREBASE WIP

  ======================================================= */



  async function handleSendToWip(selectedOnly = false) {
    if ((selectedOnly ? selectedIds.size === 0 : draftIds.length === 0) || sending) return;
    const sendingIds = selectedOnly ? draftIds.filter((id) => selectedIds.has(id)) : [...draftIds];
    const assignedName = signatureName.trim();
    if (!assignedName || assignedName.length > 250) {
      showMessage("Enter a Signed By name (1–250 characters) before sending to WIP.", "error");
      return;
    }
    setSending(true);
    try {
      // This must commit to IndexedDB BEFORE removing IDs from Collect.
      const result = await queueWip(sendingIds, assignedName);
      const safelyQueued = new Set([...result.queued, ...result.alreadyQueued]);
      // Keep the localStorage draft mirror in step immediately; queued IDs are
      // also excluded on reload using the outbox, even after a sudden crash.
      const remaining = draftIds.filter((id) => !safelyQueued.has(id));
      writeDraft(remaining);
      try { await writeStoredDraft(remaining); }
      catch (error) { console.warn("Draft backup unavailable, queued IDs are still safe in IndexedDB:", error); }
      setDraftIds((current) => current.filter((id) => !safelyQueued.has(id)));
      setSelectedIds((current) => new Set([...current].filter((id) => !safelyQueued.has(id))));
      notifyQueueChanged();
      void refresh();
      showMessage(
        online
          ? `${result.queued.length} ID${result.queued.length === 1 ? "" : "s"} saved on device · syncing to WIP`
          : `${result.queued.length} ID${result.queued.length === 1 ? "" : "s"} saved on device · will sync automatically`,
        "success"
      );
    } catch (error) {
      showMessage(error?.message || "Could not save the submission on this device. IDs remain in Collect.", "error");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }


  return (

    <main className="app-shell">

      {/* ===================================================

          NAVIGATION

      =================================================== */}



      <header className="topbar">

        <div className="topbar-inner">

          <a

            href="/"

            className="brand"

          >

            Locker

          </a>



          <nav className="nav-tabs">

            <a

              href="/"

              className="nav-tab active"

            >

              Collect

            </a>



            <a

              href="/wip"

              className="nav-tab"

            >

              WIP



              {wipItems.length > 0 && (

                <span className="nav-count">

                  {wipItems.length}

                </span>

              )}

            </a>





          </nav>



          <div className="sync-status">

            <span

              className={`sync-dot ${

                online ? "online" : ""

              }`}

            />



            {online
              ? pending > 0 ? `${pending} pending` : "Online"
              : pending > 0 ? `Offline · ${pending} pending` : "Offline"}

          </div>

        </div>

      </header>



      {(pending > 0 || storageError || (lastSync && Date.now() - lastSync.at < 180000 && (lastSync.added || lastSync.skipped || lastSync.failed))) && (
        <div role="status" aria-live="polite" style={{ padding: "9px 16px", background: "#f4f6f8", color: "#233343", fontSize: 13, textAlign: "center" }}>
          {storageError ? `Offline storage unavailable: ${storageError}. Do not close this page with unsent IDs.` : (
            <>
              {pending > 0 && <span>{pending} ID{pending === 1 ? "" : "s"} saved on this device · {online ? "syncing automatically" : "waiting for internet"}</span>}
              {lastSync && Date.now() - lastSync.at < 180000 && (lastSync.added > 0 || lastSync.skipped > 0) && (
                <span>{pending > 0 ? " · " : ""}{lastSync.added > 0 ? `${lastSync.added} sent to WIP` : ""}{lastSync.added > 0 && lastSync.skipped > 0 ? " · " : ""}{lastSync.skipped > 0 ? `${lastSync.skipped} already existed` : ""}</span>
              )}
              {lastSync?.failed > 0 && <span> · Sync could not finish; pending IDs will retry</span>}
            </>
          )}
        </div>
      )}

      {/* ===================================================

          COLLECT PAGE

      =================================================== */}



      <div

        className={`collect-page ${

          draftIds.length > 0

            ? "has-floating-action"

            : ""

        }`}

      >

        {/* HERO */}



        <section className="collect-hero">

          <div className="hero-orb hero-orb-one" />

          <div className="hero-orb hero-orb-two" />



          <div className="hero-content">

            <div className="hero-icon">

              <ScanIcon />

            </div>



            <div>

              <h1>Collect IDs</h1>



              <p>

                Scan individually or paste a

                list. Review everything before

                sending it to WIP.

              </p>

            </div>

          </div>

        </section>



        {/* COLLECTOR */}



        <section className="collector-card">

          <div className={controls.quickBar}>

            <div className={controls.cameraCopy}>

              <strong>Camera capture</strong>

              <span>Capture, confirm, then add each ID</span>

            </div>

            <button

              type="button"

              className={controls.cameraButton}

              onClick={() => { setRescanId(null); setCameraOpen(true); }}

              aria-label="Open camera scanner"

            >

              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">

                <path d="M5 7h3l2-2h4l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>

                <circle cx="12" cy="13" r="3.2" stroke="currentColor" strokeWidth="1.8"/>

              </svg>

              Open camera

            </button>

          </div>



          <div className="collector-label">

            <div>

              <span className="eyebrow">

                INPUT

              </span>



              <h2>Scan or paste IDs</h2>

            </div>



            {draftIds.length > 0 && (

              <div className="ready-pill">

                <span />



                {draftIds.length} ready

              </div>

            )}

          </div>



          <label className={controls.nameField}>

            <span>Signed By <span className={controls.fieldNote}>· Assigned to IDs sent to WIP</span></span>

            <input

              value={signatureName}

              onChange={(event) => setSignatureName(event.target.value)}

              maxLength={250}

              placeholder="Enter the name to appear on the sign-out"

              autoComplete="off"

              spellCheck={false}

              aria-invalid={!signatureName.trim()}

            />

          </label>



          <textarea

            ref={inputRef}

            className="id-input"

            value={input}

            onChange={(event) =>

              setInput(

                event.target.value

              )

            }

            onKeyDown={handleKeyDown}

            placeholder={

              "Scan an ID or paste a list..."

            }

          />



          <div className="input-footer">

            <div className="scanner-hint">

              <div className="key-cap">

                ↵

              </div>



              Scanner Enter adds one ID

            </div>



            <button

              className="stage-button"

              onClick={handleStage}

              disabled={!input.trim()}

            >

              <span>+</span>

              Add to collection

            </button>

          </div>



          {cameraOpen && <BarcodeCamera

            replaceId={rescanId}

            onAdd={acceptCameraId}

            onClose={() => { setCameraOpen(false); setRescanId(null); }}

          />}



          {/* COLLECTION */}



          {draftIds.length > 0 && (

            <div className="collection-area">

              <div className="collection-header">

                <div>

                  <span className="eyebrow">

                    COLLECTION

                  </span>



                  <h3>

                    Ready to send

                  </h3>

                </div>



                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>

                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>

                    <input type="checkbox" checked={draftIds.length > 0 && draftIds.every((id) => selectedIds.has(id))}

                      onChange={(e) => setSelectedIds(e.target.checked ? new Set(draftIds) : new Set())} />

                    Select all

                  </label>

                  {selectedIds.size > 0 && <button className="quiet-button" disabled={sending || Boolean(storageError) || !signatureName.trim()} onClick={() => handleSendToWip(true)}>Send selected ({selectedIds.size}) to WIP</button>}

                  {selectedIds.size > 0 && <button className="quiet-button danger-text" onClick={removeSelectedDraft}>Remove selected ({selectedIds.size})</button>}

                  <button className="quiet-button danger-text" onClick={clearDraft}>Clear all</button>

                </div>

              </div>



              <div className="id-grid">

                {draftIds.map((id) => (

                  <div

                    className="id-chip"

                    key={id}

                  >

                    <input type="checkbox" aria-label={`Select ${id}`} checked={selectedIds.has(id)} onChange={(e) => {

                      setSelectedIds((current) => { const next = new Set(current); if (e.target.checked) next.add(id); else next.delete(id); return next; });

                    }} />

                    {editId === id ? <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>

                      <input aria-label={`Edit ${id}`} value={editValue} onChange={(e) => setEditValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditId(null); }} />

                      <button onClick={saveEdit}>Save</button>

                      <button onClick={() => setEditId(null)}>Cancel</button>

                    </div> : <span className="id-value">{id}</span>}

                    <button className="chip-remove" title="Edit ID" aria-label={`Edit ${id}`} onClick={() => { setEditId(id); setEditValue(id); }}>✎</button>

                    <button className="chip-remove" title="Rescan ID" aria-label={`Rescan ${id}`} onClick={() => { setRescanId(id); setCameraOpen(true); }}>▣</button>

                    <button className="chip-remove" onClick={() => removeDraft(id)} aria-label={`Remove ${id}`}>×</button>

                  </div>

                ))}

              </div>

            </div>

          )}



          {/* STATUS */}



          {message && (

            <div

              className={`toast-message ${

                messageType === "error"

                  ? "error"

                  : ""

              }`}

            >

              <span className="toast-icon">

                {messageType === "error"

                  ? "!"

                  : "✓"}

              </span>



              {message}

            </div>

          )}

        </section>



        {/* =================================================

            STICKY WIP ACTION



            Appears whenever IDs are staged and stays

            accessible while scrolling through long lists.

        ================================================= */}



        {draftIds.length > 0 && (

          <div className="floating-send">

            <div className="floating-send-inner">

              <div className="floating-send-count">

                <div className="floating-send-icon">

                  <UploadIcon />

                </div>



                <div className="floating-send-copy">

                  <strong>

                    {draftIds.length}{" "}

                    {draftIds.length === 1

                      ? "ID"

                      : "IDs"}{" "}

                    ready

                  </strong>



                  <span>

                    Signed By: {signatureName.trim() || "Name required"}

                  </span>

                </div>

              </div>



              <button

                className="floating-send-button"

                onClick={

                  () => handleSendToWip(false)

                }

                disabled={

                  sending ||

                  Boolean(storageError) ||

                  !signatureName.trim()

                }

              >

                {sending

                  ? "Sending..."

                  : `Send ${draftIds.length} to WIP`}



                {!sending && (

                  <span className="send-arrow">

                    →

                  </span>

                )}

              </button>

            </div>

          </div>

        )}

      </div>

    </main>

  );

}