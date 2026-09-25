"use client";

import Link from "next/link";

import {
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  subscribeToCompleted,
} from "../../lib/firebase";

function formatTime(timestamp) {
  if (!timestamp) {
    return "";
  }

  return new Intl.DateTimeFormat(
    "en-US",
    {
      hour: "numeric",
      minute: "2-digit",
    }
  ).format(
    new Date(timestamp)
  );
}

function getDateKey(timestamp) {
  const date =
    new Date(timestamp);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateLabel(timestamp) {
  const target =
    new Date(timestamp);

  const today =
    new Date();

  const targetDay =
    new Date(
      target.getFullYear(),
      target.getMonth(),
      target.getDate()
    );

  const todayDay =
    new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );

  const difference =
    Math.round(
      (todayDay - targetDay) /
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
      month: "long",
      day: "numeric",

      year:
        target.getFullYear() !==
        today.getFullYear()
          ? "numeric"
          : undefined,
    }
  );
}

function getCompletionLabel(type) {
  if (
    type ===
    "already_signed_out"
  ) {
    return "Already signed out";
  }

  return "Signed out";
}

export default function CompletedPage() {
  const [items, setItems] =
    useState([]);

  const [connected, setConnected] =
    useState(false);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    const unsubscribe =
      subscribeToCompleted(
        (completedItems) => {
          setItems(
            completedItems
          );

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

  const groups =
    useMemo(() => {
      const grouped = {};

      items.forEach(
        (item) => {
          const timestamp =
            item.completedAt ||
            item.updatedAt ||
            Date.now();

          const key =
            getDateKey(
              timestamp
            );

          if (!grouped[key]) {
            grouped[key] = {
              key,
              timestamp,
              items: [],
            };
          }

          grouped[
            key
          ].items.push(item);
        }
      );

      return Object.values(
        grouped
      ).sort(
        (a, b) =>
          b.timestamp -
          a.timestamp
      );
    }, [items]);

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
              className="nav-tab"
            >
              WIP
            </Link>

            <Link
              href="/completed"
              className="nav-tab active"
            >
              Completed

              {items.length > 0 && (
                <span className="nav-count">
                  {items.length}
                </span>
              )}
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
                ✓
              </div>

              <div>
                <h1>
                  Completed
                </h1>

                <p>
                  Packages processed
                  through MSPT.
                </p>
              </div>
            </div>
          </div>

          <div className="wip-total-card">
            <span>
              Completed
            </span>

            <strong>
              {items.length}
            </strong>
          </div>
        </section>

        <section className="wip-content">
          {loading && (
            <div className="wip-empty">
              <div className="empty-shape">
                <span />
                <span />
                <span />
              </div>

              <h2>
                Loading Completed
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
                  Nothing completed yet
                </h2>

                <p>
                  Successfully processed
                  WIP items will appear
                  here.
                </p>

                <Link
                  href="/wip"
                  className="empty-action"
                >
                  View WIP
                </Link>
              </div>
            )}

          {groups.map(
            (group) => (
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
                        className="wip-row"
                        key={
                          item.internalId
                        }
                      >
                        <div className="wip-item-symbol">
                          <span />
                        </div>

                        <div className="wip-item-main">
                          <strong>
                            {
                              item.internalId
                            }
                          </strong>

                          <span>
                            Completed{" "}
                            {formatTime(
                              item.completedAt
                            )}
                          </span>
                        </div>

                        <div className="wip-state">
                          <span />

                          {getCompletionLabel(
                            item.completionType
                          )}
                        </div>
                      </div>
                    )
                  )}
                </div>
              </section>
            )
          )}
        </section>
      </div>
    </main>
  );
}