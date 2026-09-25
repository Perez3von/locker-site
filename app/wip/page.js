"use client";

import Link from "next/link";

import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  removeWipItem,
  removeWipItems,
  subscribeToWip,
  updateWipItem,
} from "../../lib/firebase";

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function getDateKey(timestamp) {
  const date = new Date(timestamp);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateLabel(timestamp) {
  const target = new Date(timestamp);
  const today = new Date();

  const targetDay = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate()
  );

  const todayDay = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  const difference = Math.round(
    (todayDay - targetDay) / 86400000
  );

  if (difference === 0) return "Today";
  if (difference === 1) return "Yesterday";

  return target.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year:
      target.getFullYear() !==
      today.getFullYear()
        ? "numeric"
        : undefined,
  });
}

export default function WipPage() {
  const [items, setItems] = useState([]);

  const [selected, setSelected] =
    useState(() => new Set());

  const [connected, setConnected] =
    useState(false);

  const [loading, setLoading] =
    useState(true);

  const [editingId, setEditingId] =
    useState(null);

  const [editingValue, setEditingValue] =
    useState("");

  const [removing, setRemoving] =
    useState(false);

  const [queueing, setQueueing] =
    useState(false);

  const [message, setMessage] =
    useState("");

  const [messageType, setMessageType] =
    useState("success");

  useEffect(() => {
    const unsubscribe = subscribeToWip(
      (wipItems) => {
        setItems(wipItems);
        setConnected(true);
        setLoading(false);
      },
      () => {
        setConnected(false);
        setLoading(false);
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const existing = new Set(
      items.map(
        (item) => item.internalId
      )
    );

    setSelected((current) => {
      return new Set(
        [...current].filter((id) =>
          existing.has(id)
        )
      );
    });
  }, [items]);

  const groups = useMemo(() => {
    const grouped = {};

    items.forEach((item) => {
      const key = getDateKey(
        item.createdAt
      );

      if (!grouped[key]) {
        grouped[key] = {
          key,
          timestamp: item.createdAt,
          items: [],
        };
      }

      grouped[key].items.push(item);
    });

    return Object.values(grouped).sort(
      (a, b) =>
        b.timestamp - a.timestamp
    );
  }, [items]);

  const allSelected =
    items.length > 0 &&
    selected.size === items.length;

  function showMessage(
    text,
    type = "success"
  ) {
    setMessage(text);
    setMessageType(type);
  }

  function toggleItem(id) {
    setSelected((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
      return;
    }

    setSelected(
      new Set(
        items.map(
          (item) => item.internalId
        )
      )
    );
  }

  async function signOutSelected() {
    if (
      !selected.size ||
      queueing
    ) {
      return;
    }

    const ids = [...selected];

    setQueueing(true);

    try {
      const response = await fetch(
        "/api/automation/test",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            ids,
          }),
        }
      );

      const data =
        await response.json();

      if (!response.ok) {
        throw new Error(
          data.error ||
            "Could not queue sign outs."
        );
      }

      setSelected(new Set());

      showMessage(
        data.count === 1
          ? "1 item queued for sign out"
          : `${data.count} items queued for sign out`
      );
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not queue selected items.",
        "error"
      );
    } finally {
      setQueueing(false);
    }
  }

  async function removeOne(id) {
    try {
      await removeWipItem(id);

      showMessage(
        `${id} removed`
      );
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not remove item.",
        "error"
      );
    }
  }

  async function removeSelected() {
    if (
      !selected.size ||
      removing
    ) {
      return;
    }

    const ids = [...selected];

    setRemoving(true);

    try {
      await removeWipItems(ids);

      setSelected(new Set());

      showMessage(
        ids.length === 1
          ? "1 item removed"
          : `${ids.length} items removed`
      );
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not remove selected items.",
        "error"
      );
    } finally {
      setRemoving(false);
    }
  }

  function beginEdit(item) {
    setEditingId(
      item.internalId
    );

    setEditingValue(
      item.internalId
    );
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingValue("");
  }

  async function saveEdit() {
    const newId =
      normalizeId(editingValue);

    if (
      !editingId ||
      !newId
    ) {
      return;
    }

    if (
      newId === editingId
    ) {
      cancelEdit();
      return;
    }

    try {
      await updateWipItem(
        editingId,
        newId
      );

      showMessage(
        `${editingId} changed to ${newId}`
      );

      cancelEdit();
    } catch (error) {
      showMessage(
        error?.message ||
          "Could not update item.",
        "error"
      );
    }
  }

  return (
    <main className="app-shell">
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
    className="nav-tab"
  >
    Collect
  </Link>

  <Link
    href="/wip"
    className="nav-tab active"
  >
    WIP

    {items.length > 0 && (
      <span className="nav-count">
        {items.length}
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
                connected
                  ? "online"
                  : ""
              }`}
            />

            {connected
              ? "Synced"
              : "Offline"}
          </div>
        </div>
      </header>

      <div className="wip-page">
        <section className="wip-hero">
          <div>
            <div className="wip-title-row">
              <div className="wip-title-icon">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M5 7.5h14M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />

                  <path
                    d="M9 12h6M9 16h4"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                  />
                </svg>
              </div>

              <div>
                <h1>
                  Work in Progress
                </h1>

                <p>
                  Items waiting for
                  processing.
                </p>
              </div>
            </div>
          </div>

          <div className="wip-total-card">
            <span>Waiting</span>

            <strong>
              {items.length}
            </strong>
          </div>
        </section>

        <section className="wip-content">
          <div className="wip-toolbar">
            <label className="select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={
                  items.length === 0
                }
              />

              <span>
                {allSelected
                  ? "All selected"
                  : "Select all"}
              </span>
            </label>

            {selected.size > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "center",
                  marginLeft: "auto",
                }}
              >
                <button
                  className="remove-selected"
                  onClick={
                    signOutSelected
                  }
                  disabled={
                    queueing ||
                    removing
                  }
                  style={{
                    background:
                      "#2563eb",
                    color: "#fff",
                  }}
                >
                  {queueing
                    ? "Queueing..."
                    : `Sign Out ${selected.size}`}
                </button>

                <button
                  className="remove-selected"
                  onClick={
                    removeSelected
                  }
                  disabled={
                    removing ||
                    queueing
                  }
                >
                  {removing
                    ? "Removing..."
                    : `Remove ${selected.size}`}
                </button>
              </div>
            )}
          </div>

          {loading && (
            <div className="wip-empty">
              <div className="empty-shape">
                <span />
                <span />
                <span />
              </div>

              <h2>
                Loading WIP
              </h2>
            </div>
          )}

          {!loading &&
            items.length === 0 && (
              <div className="wip-empty">
                <div className="empty-shape">
                  <span />
                  <span />
                  <span />
                </div>

                <h2>
                  Nothing waiting
                </h2>

                <p>
                  IDs you send from
                  Collect will appear
                  here.
                </p>

                <Link
                  href="/"
                  className="empty-action"
                >
                  Collect IDs
                </Link>
              </div>
            )}

          {groups.map((group) => (
            <section
              className="wip-group"
              key={group.key}
            >
              <div className="group-heading">
                <h2>
                  {getDateLabel(
                    group.timestamp
                  )}
                </h2>

                <span>
                  {
                    group.items
                      .length
                  }
                </span>
              </div>

              <div className="wip-list">
                {group.items.map(
                  (item) => (
                    <div
                      className={`wip-row ${
                        selected.has(
                          item.internalId
                        )
                          ? "selected"
                          : ""
                      }`}
                      key={
                        item.internalId
                      }
                    >
                      <label className="custom-check">
                        <input
                          type="checkbox"
                          checked={selected.has(
                            item.internalId
                          )}
                          onChange={() =>
                            toggleItem(
                              item.internalId
                            )
                          }
                        />

                        <span />
                      </label>

                      <div className="wip-item-symbol">
                        <span />
                      </div>

                      {editingId ===
                      item.internalId ? (
                        <div className="wip-edit">
                          <input
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
                            className="edit-save"
                            onClick={
                              saveEdit
                            }
                          >
                            Save
                          </button>

                          <button
                            className="quiet-button"
                            onClick={
                              cancelEdit
                            }
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <div className="wip-item-main">
                            <strong>
                              {
                                item.internalId
                              }
                            </strong>

                            <span>
                              Added{" "}
                              {formatTime(
                                item.createdAt
                              )}
                            </span>
                          </div>

                          <div className="wip-state">
                            <span />
                            Waiting
                          </div>

                          <div className="row-actions">
                            <button
                              className="circle-action"
                              onClick={() =>
                                beginEdit(
                                  item
                                )
                              }
                              aria-label={`Edit ${item.internalId}`}
                            >
                              ✎
                            </button>

                            <button
                              className="circle-action delete"
                              onClick={() =>
                                removeOne(
                                  item.internalId
                                )
                              }
                              aria-label={`Remove ${item.internalId}`}
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
            </section>
          ))}

          {message && (
            <div
              className={`toast-message ${
                messageType ===
                "error"
                  ? "error"
                  : ""
              }`}
            >
              <span className="toast-icon">
                {messageType ===
                "error"
                  ? "!"
                  : "✓"}
              </span>

              {message}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}