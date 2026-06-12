// Drag-and-drop creative uploader. Accepts an image by drop or click, reads
// its pixel dimensions, grades the fit against the target ad slot (or auto-
// detects the closest IAB format when no target is given), pins the file to
// IPFS via the configured provider, and reports the resulting CID upward.
//
// A muted text input below the zone preserves the original "paste a URL / CID"
// flow so nothing is lost for users who already host their creative.
import { useRef, useState, useCallback } from "react";
import { useSettings } from "../context/SettingsContext";
import { useToast } from "../context/ToastContext";
import { pinBlobToIPFS, PinConfig } from "@shared/ipfsPin";
import { matchAdFormat, fitForTarget } from "@shared/types";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const ACCEPT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — creative images, not video

interface Status {
  kind: "ok" | "warn" | "err";
  text: string;
}

/** Read intrinsic dimensions from an image Blob via a throwaway <img>. */
function readImageDims(blob: Blob): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Not a decodable image.")); };
    img.src = url;
  });
}

interface Props {
  value: string;
  onChange: (cidOrUrl: string) => void;
  /** Target slot size — enables exact-fit grading for per-format slots. */
  targetW?: number;
  targetH?: number;
  /** Smaller padding/text for the per-format grid. */
  compact?: boolean;
}

export function CreativeDropzone({ value, onChange, targetW, targetH, compact }: Props) {
  const { settings } = useSettings();
  const { push } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  function pinConfig(): PinConfig | null {
    const provider = settings.ipfsProvider;
    if (!provider || provider === "bulletin") return null;
    const apiKey = settings.ipfsApiKey || settings.pinataApiKey || "";
    return { provider, apiKey, endpoint: settings.ipfsApiEndpoint };
  }

  const handleFile = useCallback(async (file: File) => {
    setStatus(null);
    if (!ACCEPT_TYPES.includes(file.type)) {
      setStatus({ kind: "err", text: "PNG, JPG, WEBP, or GIF only (SVG rejected for safety)." });
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus({ kind: "err", text: `Too large: ${(file.size / 1024 / 1024).toFixed(1)} MB > 2 MB.` });
      return;
    }

    let dims: { w: number; h: number };
    try {
      dims = await readImageDims(file);
    } catch {
      setStatus({ kind: "err", text: "Could not read image dimensions." });
      return;
    }

    // Dimension grading: against the slot target when known, else auto-detect.
    let fitNote: Status;
    if (targetW && targetH) {
      const fit = fitForTarget(dims.w, dims.h, targetW, targetH);
      if (fit === "exact") fitNote = { kind: "ok", text: `${dims.w}×${dims.h} — exact fit ✓` };
      else if (fit === "scales") fitNote = { kind: "ok", text: `${dims.w}×${dims.h} — same ratio, scales to ${targetW}×${targetH} ✓` };
      else fitNote = { kind: "warn", text: `${dims.w}×${dims.h} — wrong ratio for ${targetW}×${targetH} slot; may letterbox.` };
    } else {
      const m = matchAdFormat(dims.w, dims.h);
      if (m && m.exact) fitNote = { kind: "ok", text: `${dims.w}×${dims.h} — standard ${m.format} ✓` };
      else if (m) fitNote = { kind: "ok", text: `${dims.w}×${dims.h} — closest to ${m.format}` };
      else fitNote = { kind: "warn", text: `${dims.w}×${dims.h} — not a standard ad size.` };
    }

    const cfg = pinConfig();
    if (!cfg) {
      setStatus({ kind: "err", text: "Set an IPFS provider in Settings to upload (or paste a URL below)." });
      return;
    }

    setUploading(true);
    setPreview(URL.createObjectURL(file));
    try {
      const result = await pinBlobToIPFS(cfg, file, file.name);
      if (!result.ok || !result.cid) throw new Error(result.error ?? "Pin failed");
      onChange(result.cid);
      setStatus(fitNote);
      if (result.warning) push(result.warning, "warn");
    } catch (err) {
      setStatus({ kind: "err", text: (err as Error).message });
      push((err as Error).message, "error");
      setPreview(null);
    } finally {
      setUploading(false);
    }
  }, [targetW, targetH, settings, onChange, push]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const statusColor = status
    ? status.kind === "err" ? "var(--error)" : status.kind === "warn" ? "var(--warn)" : "var(--ok)"
    : "var(--text-muted)";

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !uploading && fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !uploading) fileRef.current?.click(); }}
        style={{
          border: `1px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
          background: dragging ? "var(--accent-dim, rgba(160,160,255,0.08))" : "transparent",
          borderRadius: "var(--radius-sm)",
          padding: compact ? "8px 10px" : "16px 14px",
          cursor: uploading ? "wait" : "pointer",
          textAlign: "center",
          transition: "border-color 150ms ease, background 150ms ease",
          display: "flex", alignItems: "center", gap: 10,
          justifyContent: preview ? "flex-start" : "center",
        }}
      >
        {preview && (
          <img
            src={preview}
            alt=""
            style={{ width: compact ? 28 : 40, height: compact ? 28 : 40, objectFit: "contain", flexShrink: 0, borderRadius: 3, background: "var(--bg-faint, rgba(0,0,0,0.2))" }}
          />
        )}
        <span style={{ color: dragging ? "var(--accent)" : "var(--text-muted)", fontSize: compact ? 11 : 12 }}>
          {uploading
            ? "Pinning to IPFS…"
            : value
              ? "Replace — drop or click"
              : dragging
                ? "Drop to upload"
                : <>Drag image here{compact ? "" : " or click to upload"}</>}
        </span>
      </div>

      <input
        type="file"
        ref={fileRef}
        accept={ACCEPT}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          if (e.target) e.target.value = "";
        }}
      />

      {/* Manual URL / CID fallback — preserves the original paste flow. */}
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setPreview(null); setStatus(null); }}
        className="nano-input"
        placeholder="…or paste an https:// URL or IPFS CID"
        style={{ fontSize: 11, marginTop: 6 }}
      />

      {status && (
        <div style={{ color: statusColor, fontSize: 11, marginTop: 4 }}>{status.text}</div>
      )}
    </div>
  );
}
