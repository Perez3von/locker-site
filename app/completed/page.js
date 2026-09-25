"use client";

import Link from "next/link";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  getCompletedPage,
  getCompletedSince,
} from "../../lib/firebase";

const COMPLETED_CACHE_KEY =
  "locker-completed-cache-v1";

function normalizeCachedItems(
  value
) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item) =>
        item &&
        item.internalId &&
        item.completedAt
    )
    .sort(
      (a, b) =>
        b.completedAt -
        a.completedAt
    );
}

function readCompletedCache() {
  try {
    const raw =
      localStorage.getItem(
        COMPLETED_CACHE_KEY
      );

    if (!raw) {
      return {
        items: [],
        hasMore: true,
      };
    }

    const parsed =
      JSON.parse(raw);

    return {
      items:
        normalizeCachedItems(
          parsed.items
        ),

      hasMore:
        parsed.hasMore !==
        false,
    };
  } catch (
    error
  ) {
    console.error(
      "Completed cache read failed:",
      error
    );

    return {
      items: [],
      hasMore: true,
    };
  }
}

function writeCompletedCache(
  items,
  hasMore
) {
  try {
    localStorage.setItem(
      COMPLETED_CACHE_KEY,

      JSON.stringify({
        savedAt:
          Date.now(),

        items,

        hasMore,
      })
    );
  } catch (
    error
  ) {
    console.error(
      "Completed cache save failed:",
      error
    );
  }
}

function mergeCompletedItems(
  current,
  incoming
) {
  const map =
    new Map();

  current.forEach(
    (item) => {
      map.set(
        item.internalId,
        item
      );
    }
  );

  incoming.forEach(
    (item) => {
      map.set(
        item.internalId,
        item
      );
    }
  );

  return [
    ...map.values(),
  ].sort(
    (a, b) =>
      (b.completedAt || 0) -
      (a.completedAt || 0)
  );
}

function formatTime(
  timestamp
) {
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

function getDateKey(
  timestamp
) {
  const date =
    new Date(timestamp);

  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateLabel(
  timestamp
) {
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
      (todayDay -
        targetDay) /
        86400000
    );

  if (
    difference === 0
  ) {
    return "Today";
  }

  if (
    difference === 1
  ) {
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

function getCompletionLabel(
  type
) {
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

  const [loading, setLoading] =
    useState(true);

  const [
    loadingMore,
    setLoadingMore,
  ] = useState(false);

  const [
    refreshing,
    setRefreshing,
  ] = useState(false);

  const [hasMore, setHasMore] =
    useState(true);

  const [
    lastDocument,
    setLastDocument,
  ] = useState(null);

  const [
    initialized,
    setInitialized,
  ] = useState(false);

  const [error, setError] =
    useState("");

  const saveCache =
    useCallback(
      (
        nextItems,
        nextHasMore
      ) => {
        writeCompletedCache(
          nextItems,
          nextHasMore
        );
      },
      []
    );

  /* =======================================================
     INITIAL LOAD

     1. Show local cache immediately.
     2. If no cache exists, fetch newest 50.
     3. If cache exists, only check for newer completions.
  ======================================================= */

  useEffect(() => {
    let cancelled =
      false;

    async function initialize() {
      const cache =
        readCompletedCache();

      if (
        cache.items.length >
        0
      ) {
        setItems(
          cache.items
        );

        setHasMore(
          cache.hasMore
        );

        setLoading(false);

        setRefreshing(
          true
        );

        try {
          const newest =
            cache.items[0];

          const newerItems =
            await getCompletedSince(
              newest.completedAt
            );

          if (cancelled) {
            return;
          }

          const merged =
            mergeCompletedItems(
              cache.items,
              newerItems
            );

          setItems(merged);

          saveCache(
            merged,
            cache.hasMore
          );
        } catch (
          error
        ) {
          console.error(
            "Could not check for new completed items:",
            error
          );

          if (!cancelled) {
            setError(
              "Could not refresh Completed. Showing saved history."
            );
          }
        } finally {
          if (!cancelled) {
            setRefreshing(
              false
            );

            setInitialized(
              true
            );
          }
        }

        return;
      }

      try {
        const result =
          await getCompletedPage();

        if (cancelled) {
          return;
        }

        setItems(
          result.items
        );

        setLastDocument(
          result.lastDocument
        );

        setHasMore(
          result.hasMore
        );

        saveCache(
          result.items,
          result.hasMore
        );
      } catch (
        error
      ) {
        console.error(
          "Completed load failed:",
          error
        );

        if (!cancelled) {
          setError(
            error?.message ||
              "Could not load Completed."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(
            false
          );

          setInitialized(
            true
          );
        }
      }
    }

    initialize();

    return () => {
      cancelled = true;
    };
  }, [saveCache]);

  /* =======================================================
     PAGINATION CURSOR FOR CACHED DATA

     Firestore's startAfter cursor is a DocumentSnapshot.
     That cannot be stored in localStorage.

     If we restored cached history, we obtain the cursor
     only when the user actually asks for more history.

     We do that by reading pages until we reach the oldest
     cached ID. This happens only when "Load More" is used,
     not every time Completed opens.
  ======================================================= */

  async function findCursorForCache() {
    if (
      items.length === 0
    ) {
      return null;
    }

    const oldestCached =
      items[
        items.length - 1
      ].internalId;

    let cursor = null;

    let safety = 0;

    while (
      safety < 1000
    ) {
      const result =
        await getCompletedPage(
          cursor
        );

      if (
        result.items.length ===
        0
      ) {
        return {
          cursor:
            result.lastDocument,

          hasMore: false,
        };
      }

      const foundIndex =
        result.items.findIndex(
          (item) =>
            item.internalId ===
            oldestCached
        );

      if (
        foundIndex !== -1
      ) {
        return {
          cursor:
            result.lastDocument,

          hasMore:
            result.hasMore,
        };
      }

      if (
        !result.hasMore
      ) {
        return {
          cursor:
            result.lastDocument,

          hasMore: false,
        };
      }

      cursor =
        result.lastDocument;

      safety++;
    }

    throw new Error(
      "Could not locate Completed pagination position."
    );
  }

  /* =======================================================
     LOAD MORE
  ======================================================= */

  async function handleLoadMore() {
    if (
      loadingMore ||
      !hasMore
    ) {
      return;
    }

    setLoadingMore(true);
    setError("");

    try {
      let cursor =
        lastDocument;

      let canLoadMore =
        hasMore;

      if (!cursor) {
        const position =
          await findCursorForCache();

        cursor =
          position?.cursor ||
          null;

        canLoadMore =
          position?.hasMore ??
          false;

        setLastDocument(
          cursor
        );

        if (
          !canLoadMore
        ) {
          setHasMore(
            false
          );

          saveCache(
            items,
            false
          );

          return;
        }
      }

      const result =
        await getCompletedPage(
          cursor
        );

      const merged =
        mergeCompletedItems(
          items,
          result.items
        );

      setItems(merged);

      setLastDocument(
        result.lastDocument
      );

      setHasMore(
        result.hasMore
      );

      saveCache(
        merged,
        result.hasMore
      );
    } catch (
      error
    ) {
      console.error(
        "Could not load more completed items:",
        error
      );

      setError(
        error?.message ||
          "Could not load more completed items."
      );
    } finally {
      setLoadingMore(
        false
      );
    }
  }

  /* =======================================================
     GROUPING
  ======================================================= */

  const groups =
    useMemo(() => {
      const grouped = {};

      items.forEach(
        (item) => {
          const timestamp =
            item.completedAt ||
            item.updatedAt ||
            item.createdAt;

          if (!timestamp) {
            return;
          }

          const key =
            getDateKey(
              timestamp
            );

          if (
            !grouped[key]
          ) {
            grouped[key] = {
              key,
              timestamp,
              items: [],
            };
          }

          grouped[
            key
          ].items.push(
            item
          );
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
            </Link>
          </nav>

          <div className="sync-status">
            <span
              className={`sync-dot ${
                error
                  ? ""
                  : "online"
              }`}
            />

            {refreshing
              ? "Checking..."
              : error
                ? "Cached"
                : "Synced"}
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
              Loaded
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
            items.length ===
              0 && (
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
                key={
                  group.key
                }
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

          {!loading &&
            items.length >
              0 && (
              <div
                style={{
                  display:
                    "flex",

                  justifyContent:
                    "center",

                  padding:
                    "28px 0 12px",
                }}
              >
                {hasMore ? (
                  <button
                    className="empty-action"
                    onClick={
                      handleLoadMore
                    }
                    disabled={
                      loadingMore
                    }
                  >
                    {loadingMore
                      ? "Loading..."
                      : "Load More"}
                  </button>
                ) : (
                  <span
                    style={{
                      color:
                        "#8b8b92",

                      fontSize:
                        "14px",
                    }}
                  >
                    All completed
                    items loaded
                  </span>
                )}
              </div>
            )}

          {error &&
            items.length >
              0 && (
              <div className="toast-message error">
                <span className="toast-icon">
                  !
                </span>

                {error}
              </div>
            )}
        </section>
      </div>
    </main>
  );
}