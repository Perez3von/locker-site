"use client";

import { useState } from "react";

export default function AutomationTestPage() {
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);

  async function runTest() {
    setLoading(true);
    setStatus("Queueing test...");

    try {
      const response = await fetch("/api/automation/test", {
        method: "POST",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not queue test.");
      }

      setStatus(`Queued: ${data.jobId}`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 20px",
      }}
    >
      <h1>Automation Test</h1>

      <div
        style={{
          marginTop: 24,
          padding: 24,
          border: "1px solid #e5e7eb",
          borderRadius: 18,
        }}
      >
        <p>
          <strong>Package:</strong> 2037202
        </p>

        <p>
          <strong>Signature field:</strong> RETAG
        </p>

        <p>
          <strong>Canvas:</strong> IST
        </p>

        <p>
          <strong>Save:</strong> Disabled for trial
        </p>

        <button
          onClick={runTest}
          disabled={loading}
          style={{
            marginTop: 18,
            border: 0,
            borderRadius: 12,
            padding: "12px 20px",
            cursor: loading ? "default" : "pointer",
            fontSize: 15,
          }}
        >
          {loading ? "Queueing..." : "Run Test"}
        </button>

        {status && (
          <p style={{ marginTop: 18 }}>
            {status}
          </p>
        )}
      </div>
    </main>
  );
}