"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import styles from "./BarcodeCamera.module.css";

const FORMATS = Object.freeze({
  auto: [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.UPC_A, BarcodeFormat.QR_CODE],
  code128: [BarcodeFormat.CODE_128],
  code39: [BarcodeFormat.CODE_39],
  retail: [BarcodeFormat.EAN_13, BarcodeFormat.UPC_A],
  qr: [BarcodeFormat.QR_CODE],
});
const FORMAT_LABELS = {
  [BarcodeFormat.CODE_128]: "Code 128",
  [BarcodeFormat.CODE_39]: "Code 39",
  [BarcodeFormat.EAN_13]: "EAN-13",
  [BarcodeFormat.UPC_A]: "UPC-A",
  [BarcodeFormat.QR_CODE]: "QR Code",
};
const CAPTURE_FRAMES = 5;
const BETWEEN_FRAMES_MS = 140;
const FRAME_MAX_WIDTH = 1500;
const PHOTO_MAX_DIMENSION = 2600;
const TAKE_PHOTO_TIMEOUT_MS = 3500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAndroid() {
  const platform = navigator.userAgentData?.platform || "";
  return /android/i.test(platform) || /android/i.test(navigator.userAgent || "");
}

function normalizeId(raw) {
  return String(raw ?? "").trim().toUpperCase();
}

function hasValidId(value) {
  return Boolean(value) && !/[\s,;]/.test(value) && value.length <= 250;
}

function releaseStream(stream) {
  if (!stream) return true;
  const tracks = stream.getTracks();
  for (const track of tracks) {
    try { track.stop(); } catch (error) { console.error("Failed to stop camera track:", error); }
  }
  return tracks.every((track) => track.readyState === "ended");
}

// Precisely match the visible video area with CSS object-fit: cover.
function coverSourceRect(videoWidth, videoHeight, viewerWidth, viewerHeight) {
  if (!(videoWidth > 0 && videoHeight > 0 && viewerWidth > 0 && viewerHeight > 0)) {
    throw new Error("The camera preview isn't ready. Try again.");
  }
  const imageRatio = videoWidth / videoHeight;
  const viewerRatio = viewerWidth / viewerHeight;
  if (imageRatio > viewerRatio) {
    const width = videoHeight * viewerRatio;
    return { x: (videoWidth - width) / 2, y: 0, width, height: videoHeight };
  }
  const height = videoWidth / viewerRatio;
  return { x: 0, y: (videoHeight - height) / 2, width: videoWidth, height };
}

function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function canvasContext(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image processing is unavailable on this device.");
  return context;
}

function visibleFrameCanvas(video, viewer) {
  const crop = coverSourceRect(video.videoWidth, video.videoHeight, viewer.clientWidth, viewer.clientHeight);
  const scale = Math.min(1, FRAME_MAX_WIDTH / crop.width);
  const canvas = createCanvas(crop.width * scale, crop.height * scale);
  canvasContext(canvas).drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// For an actual photograph decode the WHOLE image first. No artificial
// preview crop: a user's still photo may have a different aspect ratio.
async function blobToCanvas(blob, isValid) {
  if (!blob || !blob.size) throw new Error("The camera returned an empty photo.");
  if (!/^image\//i.test(blob.type || "image/jpeg")) throw new Error("Choose an image file.");
  let bitmap = null;
  let objectUrl = "";
  try {
    if (typeof createImageBitmap === "function") {
      bitmap = await createImageBitmap(blob);
    } else {
      objectUrl = URL.createObjectURL(blob);
      bitmap = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not read the photo."));
        img.src = objectUrl;
      });
    }
    if (!isValid()) return null;
    const sw = bitmap.width || bitmap.naturalWidth;
    const sh = bitmap.height || bitmap.naturalHeight;
    if (!(sw > 0 && sh > 0)) throw new Error("The photo has no usable dimensions.");
    const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(sw, sh));
    const canvas = createCanvas(sw * scale, sh * scale);
    canvasContext(canvas).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function variantCanvas(source, variant) {
  // Try full image, central scan band, and adjusted contrast. All decoding
  // happens on pixels from the SAME captured image being reviewed.
  const x = variant.crop ? source.width * 0.09 : 0;
  const y = variant.crop ? source.height * 0.20 : 0;
  const width = variant.crop ? source.width * 0.82 : source.width;
  const height = variant.crop ? source.height * 0.60 : source.height;
  const canvas = createCanvas(width, height);
  const context = canvasContext(canvas);
  if (variant.contrast) context.filter = "contrast(1.45) grayscale(1)";
  context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function decodeSnapshot(reader, source, allowedFormats, isValid) {
  for (const variant of [
    { crop: false, contrast: false },
    { crop: true, contrast: false },
    { crop: false, contrast: true },
    { crop: true, contrast: true },
  ]) {
    if (!isValid()) return null;
    const canvas = variantCanvas(source, variant);
    try {
      const decoded = await reader.decodeFromCanvas(canvas);
      const format = decoded.getBarcodeFormat();
      // Defence in depth: never accept another format, even if ZXing's hints
      // are unexpectedly ignored by a particular decoder.
      if (!allowedFormats.includes(format)) continue;
      const value = normalizeId(decoded.getText());
      if (hasValidId(value)) return { value, format: FORMAT_LABELS[format] || "Barcode" };
    } catch { /* A missing barcode is routine; try next image variant. */ }
    finally { releaseCanvas(canvas); }
  }
  return null;
}

function decoderFor(formatKey) {
  const allowed = FORMATS[formatKey] || FORMATS.auto;
  const hints = new Map([
    [DecodeHintType.POSSIBLE_FORMATS, allowed],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  return { reader: new BrowserMultiFormatReader(hints), allowed };
}

async function photoFromTrack(track) {
  if (!track || track.readyState !== "live" || typeof window.ImageCapture !== "function") return null;
  const imageCapture = new window.ImageCapture(track);
  let timeoutId;
  try {
    return await Promise.race([
      imageCapture.takePhoto(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Camera still-photo capture timed out.")), TAKE_PHOTO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export default function BarcodeCamera({ onAdd, onClose, replaceId = null }) {
  const videoRef = useRef(null);
  const viewerRef = useRef(null);
  const nativeInputRef = useRef(null);
  const streamRef = useRef(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(false);
  const decodingRef = useRef(false);
  const imageUrlRef = useRef("");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [portalReady, setPortalReady] = useState(false);
  const [android, setAndroid] = useState(false);
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
  const [focusRange, setFocusRange] = useState(null);
  const [focusDistance, setFocusDistance] = useState(0);
  const [review, setReview] = useState(null);
  const [value, setValue] = useState("");
  const [editError, setEditError] = useState("");
  const [sessionAdded, setSessionAdded] = useState(0);

  const clearPhotoUrl = useCallback(() => {
    if (imageUrlRef.current) {
      URL.revokeObjectURL(imageUrlRef.current);
      imageUrlRef.current = "";
    }
  }, []);

  // The only camera-release path. A stale permission response is rejected
  // using epochRef, and any later-acquired stream is immediately stopped.
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
      try { video.pause(); } catch { /* Not playing yet. */ }
      video.srcObject = null;
      video.removeAttribute("src");
      try { video.load(); } catch { /* Already released. */ }
    }
    if (clearCapture) clearPhotoUrl();
    if (mountedRef.current) {
      setCameraState("off");
      setShutdownVerified(ended);
      setTorchOn(false);
      setTorchSupported(false);
      setZoomRange(null);
      setFocusRange(null);
      if (clearCapture) {
        setReview(null);
        setValue("");
        setEditError("");
      }
    }
    return ended;
  }, [clearPhotoUrl]);

  const refreshCameras = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (mountedRef.current) setCameras(devices.filter((d) => d.kind === "videoinput"));
    } catch { /* Switching is optional. */ }
  }, []);

  const startCamera = useCallback(async (deviceId = "") => {
    stopCamera({ clearCapture: true });
    const epoch = epochRef.current;
    setCameraError("");
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
      const track = acquired.getVideoTracks()[0];
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
          if (capabilities.zoom?.min != null && capabilities.zoom.max > capabilities.zoom.min) {
            setZoomRange({ min: capabilities.zoom.min, max: capabilities.zoom.max, step: capabilities.zoom.step || 0.1 });
            setZoom(track.getSettings?.().zoom ?? capabilities.zoom.min);
          }
          if (capabilities.focusMode?.includes("continuous")) {
            track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
          }
          if (capabilities.focusMode?.includes("manual") && capabilities.focusDistance?.min != null && capabilities.focusDistance.max > capabilities.focusDistance.min) {
            setFocusRange({ min: capabilities.focusDistance.min, max: capabilities.focusDistance.max, step: capabilities.focusDistance.step || 0.05 });
            setFocusDistance(track.getSettings?.().focusDistance ?? capabilities.focusDistance.min);
          }
        } catch { /* Focus, torch and zoom depend on hardware. */ }
      }
      setCameraState("live");
      refreshCameras();
    } catch (error) {
      releaseStream(acquired);
      if (mountedRef.current && epoch === epochRef.current) {
        stopCamera();
        setCameraError(error?.name === "NotAllowedError"
          ? "Camera permission denied. Allow the camera in Chrome and try again."
          : error?.message || "Could not start the camera.");
      }
    }
  }, [refreshCameras, stopCamera]);

  useEffect(() => {
    mountedRef.current = true;
    setAndroid(isAndroid());
    setPortalReady(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onVisibility = () => {
      if (document.hidden) stopCamera({ clearCapture: true });
    };
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

  const clearReview = useCallback(() => {
    clearPhotoUrl();
    setReview(null);
    setValue("");
    setEditError("");
    setCameraError("");
  }, [clearPhotoUrl]);

  function publishReview({ preview, source, candidate, candidates = null, frames = 1 }) {
    const found = candidates || (candidate ? [{ ...candidate, votes: 1 }] : []);
    const first = found[0] || null;
    const status = source === "live"
      ? (!first ? "unreadable" : first.votes >= 2 && found.length === 1 ? "consistent" : found.length > 1 ? "conflict" : "single")
      : (!first ? "unreadable" : "single");
    setReview({ preview, source, candidates: found, status, frames });
    setValue(first?.value || "");
  }

  async function capture() {
    if (cameraState !== "live" || decodingRef.current || !streamRef.current?.active) return;
    const video = videoRef.current;
    const viewer = viewerRef.current;
    if (!video?.videoWidth || !video?.videoHeight || !viewer?.clientWidth || !viewer?.clientHeight) {
      setCameraError("Preview is not ready. Wait for focus and try again.");
      return;
    }
    decodingRef.current = true;
    const epoch = epochRef.current;
    const valid = () => mountedRef.current && epoch === epochRef.current && Boolean(streamRef.current?.active);
    setCameraState("decoding");
    setCameraError("");
    setEditError("");
    let preview = "";
    let unreadablePhoto = null;
    try {
      const { reader, allowed } = decoderFor(scanFormat);
      const track = streamRef.current?.getVideoTracks()[0];

      // Android prefers a still photograph when the browser supports it.
      // Existing iOS capture behavior is deliberately left unchanged.
      if (android && track && typeof window.ImageCapture === "function") {
        let photo = null;
        try { photo = await photoFromTrack(track); } catch { /* Fall back to video frames. */ }
        if (!valid()) return;
        if (photo) {
          let image = null;
          try {
            image = await blobToCanvas(photo, valid);
            if (!valid()) return;
            if (image) {
              const match = await decodeSnapshot(reader, image, allowed, valid);
              if (!valid()) return;
              if (match) {
                // The review shows the exact high-quality still photograph.
                const url = URL.createObjectURL(photo);
                clearPhotoUrl();
                imageUrlRef.current = url;
                publishReview({ preview: url, source: "photo", candidate: match });
                setCameraState("live");
                return;
              }
              unreadablePhoto = photo;
            }
          } catch {
            // A photograph unsupported by this device falls back to video.
          } finally { releaseCanvas(image); }
        }
      }

      // Browser-compatible path, and the exact existing iOS strategy:
      // five separate live frames with one vote per physical frame.
      const counts = new Map();
      const previews = new Map();
      let frames = 0;
      for (let i = 0; i < (android && unreadablePhoto ? 2 : CAPTURE_FRAMES); i += 1) {
        if (!valid()) return;
        if (i > 0) await wait(BETWEEN_FRAMES_MS);
        if (!valid()) return;
        const snapshot = visibleFrameCanvas(video, viewer);
        try {
          if (i === 0) preview = snapshot.toDataURL("image/jpeg", 0.85);
          const result = await decodeSnapshot(reader, snapshot, allowed, valid);
          if (!valid()) return;
          frames += 1;
          if (result) {
            previews.set(result.value, snapshot.toDataURL("image/jpeg", 0.85));
            const entry = counts.get(result.value) || { ...result, votes: 0 };
            entry.votes += 1;
            counts.set(result.value, entry);
            if (entry.votes >= 3 && counts.size === 1) break;
          }
        } finally { releaseCanvas(snapshot); }
      }
      if (!valid()) return;
      const candidates = [...counts.values()].sort((a, b) => b.votes - a.votes);
      if (!candidates.length && unreadablePhoto) {
        const url = URL.createObjectURL(unreadablePhoto);
        clearPhotoUrl();
        imageUrlRef.current = url;
        publishReview({ preview: url, source: "photo", candidate: null });
      } else {
        publishReview({ preview: candidates.length ? previews.get(candidates[0].value) : preview, source: "live", candidates, frames });
      }
      setCameraState("live");
    } catch (error) {
      if (valid()) {
        publishReview({ preview, source: "live", candidate: null });
        setCameraState("live");
        setCameraError(error?.message || "Capture failed. Retake or use the phone camera.");
      }
    } finally {
      decodingRef.current = false;
    }
  }

  // The file chooser opens via a direct button tap, after every owned camera
  // track has been stopped. Chrome may open the native camera OR a file picker.
  // Neither behavior is guaranteed by the HTML capture attribute.
  function openNativeCamera() {
    if (decodingRef.current) return;
    stopCamera({ clearCapture: true });
    setCameraError("");
    setEditError("");
    const input = nativeInputRef.current;
    if (!input) return;
    input.value = ""; // taking the same photo again must fire change
    try { input.click(); } catch (error) {
      setCameraError(error?.message || "Could not open the phone camera.");
    }
  }

  async function onNativePhoto(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.type && !file.type.startsWith("image/")) {
      setCameraError("Please capture an image, not a video.");
      return;
    }
    if (decodingRef.current) return;
    decodingRef.current = true;
    const epoch = epochRef.current;
    const valid = () => mountedRef.current && epoch === epochRef.current;
    setCameraState("decoding-photo");
    setCameraError("");
    setEditError("");
    try {
      const { reader, allowed } = decoderFor(scanFormat);
      const image = await blobToCanvas(file, valid);
      if (!valid()) { releaseCanvas(image); return; }
      if (!image) return;
      let result;
      try { result = await decodeSnapshot(reader, image, allowed, valid); }
      finally { releaseCanvas(image); }
      if (!valid()) return;
      const url = URL.createObjectURL(file);
      clearPhotoUrl();
      imageUrlRef.current = url;
      publishReview({ preview: url, source: "photo", candidate: result });
    } catch (error) {
      if (valid()) setCameraError(error?.message || "Could not read this photo. Try again.");
    } finally {
      if (valid()) setCameraState("off");
      decodingRef.current = false;
      event.target.value = "";
    }
  }

  function addAndContinue() {
    const id = normalizeId(value);
    if (!hasValidId(id)) {
      setEditError("Enter one Internal ID (up to 250 characters, no spaces or separators).");
      return;
    }
    try {
      if (onAdd(id) === false) {
        setEditError("Not added. This ID may already be in the collection or WIP.");
        return;
      }
      setSessionAdded((count) => count + 1);
      clearReview();
      // For live scans, reuse the same camera. Native scans require another tap.
    } catch (error) {
      setEditError(error?.message || "Could not add this ID.");
    }
  }

  function manualEntry() {
    stopCamera({ clearCapture: true });
    publishReview({ preview: "", source: "manual", candidate: null });
    setEditError("");
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
      if (track.readyState === "live") setTorchOn((current) => !current);
    } catch { setCameraError("Flashlight control is not available on this camera."); }
  }

  async function changeZoom(next) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: Number(next) }] });
      if (track.readyState === "live") setZoom(Number(next));
    } catch { setCameraError("Zoom isn't supported at that level."); }
  }

  async function changeFocus(next) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ focusMode: "manual", focusDistance: Number(next) }] });
      if (track.readyState === "live") setFocusDistance(Number(next));
    } catch { setCameraError("Manual focus isn't supported by this camera."); }
  }

  const active = cameraState === "live" || cameraState === "decoding";
  const busy = cameraState === "starting" || cameraState === "decoding" || cameraState === "decoding-photo";
  const captured = Boolean(review);
  const cameraBadge = cameraState === "starting" ? "Opening camera…"
    : cameraState === "decoding" || cameraState === "decoding-photo" ? "Reading…"
    : active ? "Camera on" : "Camera off";

  const interfaceNode = (
    <div className={styles.backdrop}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Barcode scanner">
        <header className={styles.header}>
          <div className={styles.heading}>
            <strong>{replaceId ? "Rescan ID" : "Scan barcodes"}</strong>
            <span className={styles.status}><i className={active ? styles.liveDot : styles.offDot} /> {cameraBadge}</span>
          </div>
          <button type="button" className={styles.done} onClick={() => { stopCamera({ clearCapture: true }); onClose(); }}>Done</button>
        </header>
        <div className={styles.content}>
          {replaceId && <div className={styles.replaceNotice}>Replacing <strong>{replaceId}</strong>. The original remains until you confirm.</div>}
          <div className={styles.options}>
            <label className={styles.control}>
              <span>Barcode type</span>
              <select value={scanFormat} onChange={(event) => setScanFormat(event.target.value)} disabled={busy}>
                <option value="auto">Auto-detect</option>
                <option value="code128">Code 128</option>
                <option value="code39">Code 39</option>
                <option value="retail">UPC / EAN</option>
                <option value="qr">QR code</option>
              </select>
            </label>
            {cameras.length > 1 && <label className={styles.control}>
              <span>Camera lens</span>
              <select value={selectedCamera} disabled={busy} onChange={(event) => {
                const id = event.target.value;
                setSelectedCamera(id);
                startCamera(id);
              }}>
                <option value="">Rear / default</option>
                {cameras.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
              </select>
            </label>}
          </div>

          <div className={styles.viewer} ref={viewerRef}>
            <video className={styles.video} ref={videoRef} playsInline muted autoPlay />
            {review?.preview && <img className={`${styles.frozen} ${review.source === "photo" ? styles.wholePhoto : ""}`} src={review.preview} alt="Captured barcode image. Compare it against the detected ID." />}
            {!review && active && <div className={styles.guides} aria-hidden="true"><span className={styles.guideCornerA} /><span className={styles.guideCornerB} /><span className={styles.guideCornerC} /><span className={styles.guideCornerD} /></div>}
            {!review && cameraState === "off" && <div className={styles.viewerOverlay}>Camera stopped</div>}
            {!review && cameraState === "starting" && <div className={styles.viewerOverlay}>Allow camera access to start</div>}
            {!review && busy && cameraState !== "starting" && <div className={styles.viewerOverlay}>Reading barcode…</div>}
            {review?.source === "manual" && <div className={styles.viewerOverlay}>Manual entry</div>}
          </div>

          {!captured && <div className={styles.actions}>
            {cameraState === "off" && <button type="button" className={styles.primary} disabled={busy} onClick={() => startCamera(selectedCamera)}>Start scanner</button>}
            {active && <button type="button" className={styles.primary} disabled={busy} onClick={capture}>{cameraState === "decoding" ? "Reading…" : "Capture barcode"}</button>}
            {cameraState === "starting" && <button type="button" className={styles.primary} onClick={() => stopCamera()}>Cancel camera</button>}
            <button type="button" className={styles.secondary} disabled={busy} onClick={openNativeCamera}><span aria-hidden="true">▣ </span>Phone camera</button>
            {active && <button type="button" className={styles.stop} onClick={() => stopCamera()}>Stop camera</button>}
            <button type="button" className={styles.manual} disabled={busy} onClick={manualEntry}>Type ID instead</button>
          </div>}
          {!captured && <p className={styles.smallNote}>{android ? "Blurry preview? Tap Phone camera for Android's photo autofocus." : "Fit the whole barcode inside the guide and tap Capture."}</p>}

          {!captured && active && (zoomRange || torchSupported || focusRange) && <details className={styles.advanced}>
            <summary>Camera controls</summary>
            <div className={styles.advancedBody}>
              {zoomRange && <label className={styles.slider}><span>Zoom {zoom.toFixed(1)}×</span><input type="range" min={zoomRange.min} max={zoomRange.max} step={zoomRange.step} value={zoom} onChange={(event) => changeZoom(event.target.value)} /></label>}
              {focusRange && <label className={styles.slider}><span>Manual focus</span><input type="range" min={focusRange.min} max={focusRange.max} step={focusRange.step} value={focusDistance} onChange={(event) => changeFocus(event.target.value)} /></label>}
              {torchSupported && <button type="button" className={styles.secondary} onClick={toggleTorch}>{torchOn ? "Turn flashlight off" : "Turn flashlight on"}</button>}
            </div>
          </details>}

          {review && <section className={styles.review} aria-label="Capture review">
            <div className={styles.reviewHeader}>
              <strong>{review.source === "manual" ? "Enter ID" : review.status === "consistent" ? "Barcode found" : review.status === "unreadable" ? "No barcode found" : review.status === "conflict" ? "Conflicting results" : "Check this reading"}</strong>
              {review.status === "consistent" && <span className={styles.consistent}>Matched across frames</span>}
            </div>
            <p className={styles.reviewHint}>{review.source === "manual"
              ? "Type the exact Internal ID from the label."
              : review.status === "consistent"
                ? `Detected ${review.candidates[0]?.format} in ${review.candidates[0]?.votes} frames. Verify the ID before adding.`
                : review.status === "conflict"
                  ? "Different values were found. Retake or confirm the correct number manually."
                  : review.status === "unreadable"
                    ? "No reliable reading. Try another photo, change distance, or type the ID."
                    : "Compare the large ID against the photographed barcode before adding."}</p>
            {review.status === "conflict" && <div className={styles.conflicts}>{review.candidates.map((item) => `${item.value} (${item.votes}×)`).join(" · ")}</div>}
            <label className={styles.valueLabel} htmlFor="locker-scanned-id">Internal ID · editable</label>
            <input id="locker-scanned-id" className={styles.bigValue} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} value={value} onChange={(event) => { setValue(event.target.value); setEditError(""); }} placeholder="Enter or verify ID" />
            {editError && <div className={styles.error} role="alert">{editError}</div>}
            <div className={styles.reviewActions}>
              <button type="button" className={styles.primary} onClick={addAndContinue}>{replaceId ? "Replace & continue" : "Add & continue"}</button>
              <button type="button" className={styles.secondary} onClick={clearReview}>Retake</button>
            </div>
            <div className={styles.reviewExtras}>
              <button type="button" className={styles.linkButton} onClick={openNativeCamera}>Use phone camera</button>
              {active && <button type="button" className={styles.linkButton} onClick={() => stopCamera()}>Stop camera, keep result</button>}
            </div>
            {!active && review.source !== "manual" && <p className={styles.smallNote}>Camera is off. Use Phone camera again or Start scanner for your next ID.</p>}
          </section>}

          {sessionAdded > 0 && <div className={styles.added} role="status">{sessionAdded} {sessionAdded === 1 ? "ID" : "IDs"} added this session</div>}
          {cameraError && <div className={styles.error} role="alert">{cameraError}</div>}
          {!shutdownVerified && <div className={styles.error} role="alert">Could not verify camera shutdown. Close this tab and inspect Chrome's camera indicator.</div>}
          <p className={styles.privacy}>Live frames and chosen photos are processed locally in Locker, not sent to Firestore. Done and Stop release the scanner's camera tracks. Your phone's camera app may retain a photo separately.</p>

          {/* The native chooser stays mounted and uses the OS camera when supported. */}
          <input className={styles.nativeInput} ref={nativeInputRef} type="file" accept="image/*" capture="environment" onChange={onNativePhoto} tabIndex={-1} aria-hidden="true" />
        </div>
      </div>
    </div>
  );

  return portalReady ? createPortal(interfaceNode, document.body) : null;
}
