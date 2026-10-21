"use client";

import { useCallback, useEffect, useState } from "react";
import {
  QUEUE_CHANGED, SYNC_CHANGED, lastSyncSummary, pendingCount, syncPending,
} from "./offlineQueue";

let workerRegistrationStarted = false;

function registerWorker() {
  if (workerRegistrationStarted || !("serviceWorker" in navigator)) return;
  workerRegistrationStarted = true;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
    workerRegistrationStarted = false;
    console.warn("Offline app registration failed:", error);
  });
}

export function useOfflineRuntime() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  const [lastSync, setLastSync] = useState(null);
  const [storageError, setStorageError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setPending(await pendingCount());
      setStorageError("");
    } catch (error) {
      setStorageError(error?.message || "Local offline storage is unavailable.");
    }
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);
    setLastSync(lastSyncSummary());
    registerWorker();
    void refresh();

    const attemptSync = () => {
      void syncPending().catch((error) => console.warn("WIP synchronization failed:", error))
        .finally(() => void refresh());
    };
    const onOnline = () => { setOnline(true); attemptSync(); };
    const onOffline = () => setOnline(false);
    const onQueue = () => { void refresh(); if (navigator.onLine) attemptSync(); };
    const onSync = (event) => { setLastSync(event.detail); void refresh(); };
    const onVisibility = () => { if (!document.hidden) attemptSync(); };
    const onStorage = (event) => { if (event.key === "locker-last-sync-v1") setLastSync(lastSyncSummary()); };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener(QUEUE_CHANGED, onQueue);
    window.addEventListener(SYNC_CHANGED, onSync);
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    const interval = window.setInterval(attemptSync, 30000);
    attemptSync();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener(QUEUE_CHANGED, onQueue);
      window.removeEventListener(SYNC_CHANGED, onSync);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { online, pending, lastSync, storageError, refresh };
}
