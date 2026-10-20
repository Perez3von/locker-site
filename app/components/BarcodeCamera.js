"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import styles from "./BarcodeCamera.module.css";

const FORMATS = {
  auto: [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.QR_CODE],
  code128: [BarcodeFormat.CODE_128],
  code39: [BarcodeFormat.CODE_39],
  retail: [BarcodeFormat.EAN_13, BarcodeFormat.UPC_A],
  qr: [BarcodeFormat.QR_CODE],
};
const FORMAT_LABELS = {
  [BarcodeFormat.CODE_128]: "Code 128",
  [BarcodeFormat.CODE_39]: "Code 39",
  [BarcodeFormat.EAN_13]: "EAN-13",
  [BarcodeFormat.UPC_A]: "UPC-A",
  [BarcodeFormat.QR_CODE]: "QR Code",
};
const CAPTURE_FRAMES = 5;
const BETWEEN_FRAMES_MS = 140;
const MAX_DECODE_WIDTH = 1500;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeId(raw) {
  return String(raw ?? "").trim().toUpperCase();
}

function hasValidId(value) {
  return Boolean(value) && !/[\s,;]/.test(value) && value.length <= 250;
}

function releaseStream(stream) {
  if (!stream) return true;
  const tracks = stream.getTracks();
  tracks.forEach((track) => {
    try { track.stop(); } catch (error) { console.error("Camera track stop failed:", error); }
  });
  return tracks.every((track) => track.readyState === "ended");
}

function frameCanvas(video, crop = false, highContrast = false) {
  const sw = video.videoWidth;
  const sh = video.videoHeight;
  const sx = crop ? sw * 0.07 : 0;
  const sy = crop ? sh * 0.20 : 0;
  const sourceWidth = crop ? sw * 0.86 : sw;
  const sourceHeight = crop ? sh * 0.60 : sh;
  const scale = Math.min(1, MAX_DECODE_WIDTH / sourceWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image processing is unavailable on this device.");
  if (highContrast) context.filter = "contrast(1.45) grayscale(1)";
  context.drawImage(video, sx, sy, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Up to three decode attempts, but each *frame* contributes at most one vote. */
async function decodeFrame(reader, video, isValid) {
  for (const variant of [{ crop: false, contrast: false }, { crop: true, contrast: false }, { crop: false, contrast: true }]) {
    if (!isValid()) return null;
    const canvas = frameCanvas(video, variant.crop, variant.contrast);
    try {
      const decoded = await reader.decodeFromCanvas(canvas);
      const value = normalizeId(decoded.getText());
      if (hasValidId(value)) {
        return { value, format: FORMAT_LABELS[decoded.getBarcodeFormat()] || "Barcode" };
      }
    } catch { /* A single unsuccessful attempt is expected; try the next variant. */ }
    finally { canvas.width = 0; canvas.height = 0; }
  }
  return null;
}

function capturePreview(video) {
  const width = Math.min(video.videoWidth, 1050);
  const height = Math.round(video.videoHeight * width / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  const url = canvas.toDataURL("image/jpeg", 0.85);
  canvas.width = 0;
  canvas.height = 0;
  return url;
}

export default function BarcodeCamera({ onAdd, onClose, replaceId = null }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(false);
  const decodingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [portalReady, setPortalReady] = useState(false);
  const [cameraState, setCameraState] = useState("off");
  const [cameraError, setCameraError] = useState("");
  const [shutdownVerified, setShutdownVerified] = useState(true);
  const [scanFormat, setScanFormat] = useState("auto");
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [zoomRange, setZoomRange] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [review, setReview] = useState(null);
  const [value, setValue] = useState("");
  const [editError, setEditError] = useState("");
  const [sessionAdded, setSessionAdded] = useState(0);

  // This is the only code path responsible for releasing a camera stream.
  // Calling it also invalidates any pending permission request or decoding result.
  const stopCamera = useCallback(({ clearCapture = false } = {}) => {
    epochRef.current += 1;
    decodingRef.current = false;
    const stream = streamRef.current;
    streamRef.current = null;
    const video = videoRef.current;
    let ended = releaseStream(stream);
    if (video) {
      const attached = video.srcObject;
      if (attached && attached !== stream && typeof attached.getTracks === "function") {
        ended = releaseStream(attached) && ended;
      }
      try { video.pause(); } catch { /* Video might not have played yet. */ }
      video.srcObject = null;
      video.removeAttribute("src");
      try { video.load(); } catch { /* Browser may already be tearing down. */ }
    }
    if (mountedRef.current) {
      setCameraState("off");
      setShutdownVerified(ended);
      setTorchOn(false);
      setTorchSupported(false);
      setZoomRange(null);
      if (clearCapture) {
        setReview(null);
        setValue("");
        setEditError("");
      }
    }
    return ended;
  }, []);

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (mountedRef.current) setCameras(devices.filter((d) => d.kind === "videoinput"));
    } catch { /* Camera switching is optional. */ }
  }, []);

  const startCamera = useCallback(async (deviceId = "") => {
    stopCamera();
    const epoch = epochRef.current;
    setReview(null);
    setValue("");
    setCameraError("");
    setEditError("");
    setShutdownVerified(true);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera access requires HTTPS or localhost and a compatible browser.");
      return;
    }
    setCameraState("starting");
    let acquired = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      if (!mountedRef.current || epoch !== epochRef.current || document.hidden) {
        releaseStream(acquired);
        return;
      }
      streamRef.current = acquired;
      const video = videoRef.current;
      if (!video) throw new Error("Video preview is unavailable.");
      video.srcObject = acquired;
      await video.play();
      if (!mountedRef.current || epoch !== epochRef.current || document.hidden) {
        releaseStream(acquired);
        if (video.srcObject === acquired) video.srcObject = null;
        return;
      }
      const [track] = acquired.getVideoTracks();
      if (track) {
        track.addEventListener("ended", () => {
          if (epoch === epochRef.current) {
            stopCamera();
            setCameraError("Camera disconnected. Start it again to continue.");
          }
        }, { once: true });
        try {
          const capabilities = track.getCapabilities?.() || {};
          setTorchSupported(Boolean(capabilities.torch));
          if (capabilities.zoom?.min != null && capabilities.zoom?.max > capabilities.zoom?.min) {
            const actualZoom = track.getSettings?.().zoom ?? capabilities.zoom.min;
            setZoomRange({ min: capabilities.zoom.min, max: capabilities.zoom.max, step: capabilities.zoom.step || 0.1 });
            setZoom(actualZoom);
          }
          if (capabilities.focusMode?.includes("continuous")) {
            track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
          }
        } catch { /* All of these controls are optional. */ }
      }
      setCameraState("live");
      refreshCameras();
    } catch (error) {
      releaseStream(acquired);
      if (epoch === epochRef.current && mountedRef.current) {
        stopCamera();
        const denied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
        setCameraError(denied
          ? "Camera access was denied. Allow camera permission in your browser and try again."
          : (error?.message || "Could not start camera."));
      }
    }
  }, [refreshCameras, stopCamera]);

  useEffect(() => {
    mountedRef.current = true;
    setPortalReady(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onVisibility = () => { if (document.hidden) stopCamera({ clearCapture: true }); };
    const onPageHide = () => stopCamera({ clearCapture: true });
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        stopCamera({ clearCapture: true });
        onCloseRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("keydown", onKeyDown);
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshCameras);
    return () => {
      mountedRef.current = false;
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("keydown", onKeyDown);
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshCameras);
      stopCamera({ clearCapture: true });
    };
  }, [refreshCameras, stopCamera]);

  async function capture() {
    if (cameraState !== "live" || decodingRef.current || !streamRef.current?.active) return;
    const video = videoRef.current;
    if (!video?.videoWidth || !video?.videoHeight) {
      setCameraError("Preview is not ready. Wait for focus and try Capture again.");
      return;
    }
    decodingRef.current = true;
    const epoch = epochRef.current;
    const isValid = () => mountedRef.current && epoch === epochRef.current && streamRef.current?.active;
    setCameraState("decoding");
    setCameraError("");
    setEditError("");
    const counts = new Map();
    let preview = "";
    let validFrameCount = 0;
    try {
      preview = capturePreview(video);
      const hints = new Map([
        [DecodeHintType.POSSIBLE_FORMATS, FORMATS[scanFormat]],
        [DecodeHintType.TRY_HARDER, true],
      ]);
      const reader = new BrowserMultiFormatReader(hints);
      for (let i = 0; i < CAPTURE_FRAMES; i += 1) {
        if (!isValid()) return;
        if (i > 0) await pause(BETWEEN_FRAMES_MS);
        if (!isValid()) return;
        // Count at most one decoded value per distinct camera frame.
        const decoded = await decodeFrame(reader, video, isValid);
        if (!isValid()) return;
        validFrameCount += 1;
        if (decoded) {
          // Freeze a frame that actually produced a decoded barcode for the review.
          preview = capturePreview(video);
          const current = counts.get(decoded.value) || { ...decoded, votes: 0 };
          current.votes += 1;
          counts.set(decoded.value, current);
          if (current.votes >= 3 && counts.size === 1) break;
        }
      }
      if (!isValid()) return;
      const candidates = [...counts.values()].sort((a, b) => b.votes - a.votes);
      const winner = candidates[0] || null;
      // Agreement of 2+ frames is useful evidence, not a guarantee of accuracy.
      const consistent = winner && winner.votes >= 2 && (candidates[1]?.votes || 0) === 0;
      setReview({
        preview,
        candidates,
        status: !winner ? "unreadable" : consistent ? "consistent" : candidates.length > 1 ? "conflict" : "single",
        frames: validFrameCount,
      });
      setValue(winner?.value || "");
      setCameraState("live");
    } catch (error) {
      if (isValid()) {
        setReview({ preview, candidates: [], status: "unreadable", frames: validFrameCount });
        setValue("");
        setCameraState("live");
        setCameraError(error?.message || "Capture failed. Please try again.");
      }
    } finally {
      decodingRef.current = false;
    }
  }

  function retake() {
    setReview(null);
    setValue("");
    setEditError("");
    setCameraError("");
  }

  function manualEntry() {
    stopCamera({ clearCapture: true });
    setReview({ preview: "", candidates: [], status: "manual", frames: 0 });
    setValue("");
    setEditError("");
  }

  function addAndContinue() {
    const id = normalizeId(value);
    if (!hasValidId(id)) {
      setEditError("Enter exactly one ID (up to 250 characters; no spaces or separators).");
      return;
    }
    try {
      if (onAdd(id) === false) {
        setEditError("This ID was not added. It may already be in the collection or WIP.");
        return;
      }
      setSessionAdded((current) => current + 1);
      retake();
      // No request for another camera stream: reuse the existing live stream.
    } catch (error) {
      setEditError(error?.message || "Could not add this ID.");
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      if (track.readyState === "live") setTorchOn((on) => !on);
    } catch { setCameraError("Flashlight control is unavailable on this camera."); }
  }

  async function changeZoom(next) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: Number(next) }] });
      if (track.readyState === "live") setZoom(Number(next));
    } catch { setCameraError("Zoom is not supported at that level."); }
  }

  const active = cameraState === "live" || cameraState === "decoding";
  const captured = Boolean(review);
  const shutterDisabled = cameraState !== "live" || captured;
  const badge = cameraState === "starting" ? "Requesting camera…" : active ? "Camera on" : "Camera off";

  const interfaceNode = (
    <div className={styles.backdrop}>
      <div role="dialog" aria-modal="true" aria-label="Barcode scanner" className={styles.dialog}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <strong>{replaceId ? "Rescan ID" : "Scan barcodes"}</strong>
            <span className={styles.status}><i className={active ? styles.liveDot : styles.offDot} /> {badge}</span>
          </div>
          <button type="button" className={styles.done} onClick={() => { stopCamera({ clearCapture: true }); onClose(); }}>
            Done using camera
          </button>
        </header>
        <div className={styles.content}>
          {replaceId && <div className={styles.replaceNotice}>Replacing <strong>{replaceId}</strong>. The original ID stays until you confirm its replacement.</div>}
          <div className={styles.options}>
            <label className={styles.control}><span>Barcode type</span>
              <select value={scanFormat} onChange={(event) => setScanFormat(event.target.value)} disabled={cameraState === "decoding"}>
                <option value="auto">Auto-detect</option>
                <option value="code128">Code 128</option>
                <option value="code39">Code 39</option>
                <option value="retail">UPC / EAN</option>
                <option value="qr">QR code</option>
              </select>
            </label>
            {cameras.length > 1 && <label className={styles.control}><span>Camera</span>
              <select value={selectedCamera} onChange={(event) => {
                const id = event.target.value;
                setSelectedCamera(id);
                startCamera(id);
              }}>
                <option value="">Rear / default</option>
                {cameras.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
              </select>
            </label>}
          </div>

          <div className={styles.viewer}>
            <video className={styles.video} ref={videoRef} playsInline muted autoPlay />
            {review?.preview ? <img className={styles.frozen} src={review.preview} alt="Frame captured from the camera. Compare this barcode with the decoded ID." /> : null}
            {!review && active && <div className={styles.guides} aria-hidden="true"><span className={styles.guideCornerA} /><span className={styles.guideCornerB} /><span className={styles.guideCornerC} /><span className={styles.guideCornerD} /></div>}
            {!review && cameraState === "off" && <div className={styles.viewerOverlay}>Camera is stopped</div>}
            {!review && cameraState === "starting" && <div className={styles.viewerOverlay}>Waiting for camera permission…</div>}
            {!review && cameraState === "decoding" && <div className={styles.viewerOverlay}>Checking several frames…</div>}
            {review?.status === "manual" && <div className={styles.viewerOverlay}>Manual entry</div>}
          </div>
          <div className={styles.smallNote}>{review ? "Captured image is kept only in memory until Retake or Done." : "Center the whole barcode inside the guide. Hold still and tap Capture."}</div>

          {zoomRange && active && !captured && <label className={styles.zoom}><span>Zoom {zoom.toFixed(1)}×</span><input type="range" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoom} onChange={(event) => changeZoom(event.target.value)} /></label>}
          {torchSupported && active && !captured && <button className={styles.secondary} onClick={toggleTorch}>{torchOn ? "Turn flashlight off" : "Turn flashlight on"}</button>}

          {!captured && <div className={styles.actions}>
            {cameraState === "off" && <button className={styles.primary} onClick={() => startCamera(selectedCamera)}>Start camera</button>}
            {(cameraState === "live" || cameraState === "decoding") && <button className={styles.primary} disabled={shutterDisabled} onClick={capture}>{cameraState === "decoding" ? "Reading barcode…" : "Capture barcode"}</button>}
            {cameraState === "starting" && <button className={styles.secondary} onClick={() => stopCamera()}>Cancel</button>}
            {active && <button className={styles.secondary} onClick={() => stopCamera()}>Stop camera</button>}
            <button className={styles.quiet} onClick={manualEntry} disabled={cameraState === "decoding" || cameraState === "starting"}>Type ID instead</button>
          </div>}

          {review && <section className={styles.review} aria-label="Capture review">
            <div className={styles.reviewHeader}>
              <strong>{review.status === "consistent" ? "Barcode found" : review.status === "manual" ? "Enter ID" : review.status === "unreadable" ? "No barcode found" : review.status === "conflict" ? "Conflicting results" : "Check this reading"}</strong>
              {review.status === "consistent" && <span className={styles.consistent}>Matched across frames</span>}
            </div>
            <p className={styles.reviewHint}>{review.status === "consistent"
              ? `Detected ${review.candidates[0]?.format} in ${review.candidates[0]?.votes} frames. Compare the ID against the barcode image before adding.`
              : review.status === "conflict" ? "Different values were detected. Do not guess: retake, or verify and enter the correct ID manually."
              : review.status === "single" ? "Only one frame produced this value. Verify it carefully or retake."
              : review.status === "unreadable" ? "Nothing was added. Adjust distance, focus or lighting, and retake; or type the value."
              : "Type the ID exactly as printed on the label."}</p>
            {review.status === "conflict" && <div className={styles.conflicts}>Detected: {review.candidates.map((item) => `${item.value} (${item.votes}×)`).join(" · ")}</div>}
            <label className={styles.valueLabel} htmlFor="locker-scanned-id">Internal ID · editable</label>
            <input id="locker-scanned-id" className={styles.bigValue} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={value} onChange={(event) => { setValue(event.target.value); setEditError(""); }} placeholder="Enter or verify ID" />
            {editError && <div className={styles.error} role="alert">{editError}</div>}
            <div className={styles.reviewActions}>
              <button className={styles.primary} onClick={addAndContinue}> {replaceId ? "Replace & continue" : "Add & continue"}</button>
              <button className={styles.secondary} onClick={retake}>Retake</button>
            </div>
            {active && <button className={styles.quiet} onClick={() => stopCamera()}>Stop camera, keep this result</button>}
            {!active && <p className={styles.smallNote}>Camera is off. Start it again after confirming if you want to keep scanning.</p>}
          </section>}

          {sessionAdded > 0 && <div className={styles.added} role="status">{sessionAdded} {sessionAdded === 1 ? "ID" : "IDs"} added this session</div>}
          {cameraError && <div className={styles.error} role="alert">{cameraError}</div>}
          {!shutdownVerified && <div className={styles.error} role="alert">Could not confirm all camera tracks ended. Close this browser tab and check the camera indicator.</div>}
          <p className={styles.privacy}>Nothing is uploaded from the camera. Stop/Done releases this scanner's media tracks, and leaving or hiding the page releases them too. Camera hardware may still be used by another app or tab.</p>
        </div>
      </div>
    </div>
  );

  return portalReady ? createPortal(interfaceNode, document.body) : null;
}
