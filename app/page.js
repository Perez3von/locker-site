"use client";

import Link from "next/link";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  sendToWip,
  subscribeToWip,
} from "../lib/firebase";

const DRAFT_CACHE_KEY = "locker-collect-draft-v1";
const DRAFT_CACHE_DURATION = 24 * 60 * 60 * 1000;
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
  try {
    const raw = localStorage.getItem(DRAFT_CACHE_KEY);

    if (!raw) return [];

    const cache = JSON.parse(raw);

    if (
      !cache.savedAt ||
      !Array.isArray(cache.data) ||
      Date.now() - cache.savedAt > DRAFT_CACHE_DURATION
    ) {
      localStorage.removeItem(DRAFT_CACHE_KEY);
      return [];
    }

    return cache.data;
  } catch {
    return [];
  }
}

function writeDraft(data) {
  try {
    localStorage.setItem(
      DRAFT_CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        data,
      })
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
  const [draftIds, setDraftIds] = useState([]);
  const [wipItems, setWipItems] = useState([]);

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
    setDraftIds(readDraft());
    setDraftLoaded(true);

    const unsubscribe = subscribeToWip(
      (items) => {
        setWipItems(items);
        setConnected(true);
      },
      () => {
        setConnected(false);
      }
    );

    return unsubscribe;
  }, []);

  /* =======================================================
     SAVE LOCAL DRAFT
  ======================================================= */

  useEffect(() => {
    if (!draftLoaded) return;

    const timer = setTimeout(() => {
      writeDraft(draftIds);
    }, DRAFT_SAVE_DEBOUNCE);

    return () => clearTimeout(timer);
  }, [draftIds, draftLoaded]);

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

    showMessage("Collection cleared");

    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }

  /* =======================================================
     SEND TO FIREBASE WIP
  ======================================================= */

  async function handleSendToWip() {
    if (
      draftIds.length === 0 ||
      sending
    ) {
      return;
    }

    if (!connected) {
      showMessage(
        "WIP is currently unavailable. Your IDs are still saved on this device.",
        "error"
      );

      return;
    }

    const sendingIds = [...draftIds];

    setSending(true);

    try {
      const result =
        await sendToWip(sendingIds);

      const completed = new Set([
        ...result.added,
        ...result.skipped,
      ]);

      setDraftIds((current) =>
        current.filter(
          (id) => !completed.has(id)
        )
      );

      if (result.failed.length) {
        showMessage(
          `${result.added.length} sent · ${result.failed.length} could not be sent and remain here`,
          "error"
        );
      } else {
        showMessage(
          result.added.length === 1
            ? "1 ID sent to WIP"
            : `${result.added.length} IDs sent to WIP`
        );
      }
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not send to WIP. Your IDs remain saved here.",
        "error"
      );
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
          <Link
            href="/"
            className="brand"
          >
            Locker
          </Link>

          <nav className="nav-tabs">
            <Link
              href="/"
              className="nav-tab active"
            >
              Collect
            </Link>

            <Link
              href="/wip"
              className="nav-tab"
            >
              WIP

              {wipItems.length > 0 && (
                <span className="nav-count">
                  {wipItems.length}
                </span>
              )}
            </Link>

            <Link
  href="/completed"
  className="nav-tab"
>
  Completed
</Link>
          </nav>

          <div className="sync-status">
            <span
              className={`sync-dot ${
                connected ? "online" : ""
              }`}
            />

            {connected
              ? "Synced"
              : "Offline"}
          </div>
        </div>
      </header>

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
            autoFocus
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

                <button
                  className="quiet-button danger-text"
                  onClick={clearDraft}
                >
                  Clear all
                </button>
              </div>

              <div className="id-grid">
                {draftIds.map((id) => (
                  <div
                    className="id-chip"
                    key={id}
                  >
                    <div className="id-chip-icon">
                      <span />
                    </div>

                    <span className="id-value">
                      {id}
                    </span>

                    <button
                      className="chip-remove"
                      onClick={() =>
                        removeDraft(id)
                      }
                      aria-label={`Remove ${id}`}
                    >
                      ×
                    </button>
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
                    Ready to move into WIP
                  </span>
                </div>
              </div>

              <button
                className="floating-send-button"
                onClick={
                  handleSendToWip
                }
                disabled={
                  sending ||
                  !connected
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