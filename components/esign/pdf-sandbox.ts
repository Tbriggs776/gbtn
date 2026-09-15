import type { DetectTextItem } from "@/lib/esign/detect-fields";

// pdf.js host for the e-sign pages (addendum S9, §4.1). pdf.js never runs on the
// portal or signing origin. It runs only inside a hidden
// <iframe sandbox="allow-scripts" srcdoc> (an opaque origin whose meta-CSP
// allows no network) and talks to this page over one MessageChannel port.
//
// The parent fetches the vendored library and worker same-origin, fetches the
// document bytes from their short signed URL, verifies SHA-256, and transfers
// COPIES into the frame. Only page geometry, plain text items and ImageBitmaps
// come back, and every reply is shape-checked here: a frame that has parsed
// hostile bytes is not trusted.
//
// Never import "pdfjs-dist" (value or type) anywhere in app code. The library
// bytes are copied into public/ by scripts/vendor-pdfjs.mjs (predev/prebuild).
// Plain browser module: import it only from client components.
//
// pdf.js's binary data never comes from the network either (amends addendum
// §4.1 item 3). The frame passes getDocument a BinaryDataFactory that answers
// from memory. The wasm image decoders (JBIG2/CCITT G4 and JPX have no JS
// decoder in 6.3.289) and the two standard fonts system fonts can't stand in
// for are fetched with the library and transferred with it. Predefined CMaps
// (~1.5 MB, needed only by some CJK PDFs) are fetched here on the frame's
// request and transferred back. As a backstop, a page whose image still
// resolved to nothing fails its render instead of coming back blank.

export const PDFJS_VERSION = "6.3.289"; // must equal scripts/vendor-pdfjs.mjs PINNED
export const PDFJS_BASE = `/vendor/pdfjs/${PDFJS_VERSION}`; // pdf.js + pdf.worker.js + binary data

export type SandboxPage = { index: number; view: [number, number, number, number]; rotate: number };
export type SandboxOpenResult =
  | { ok: true; numPages: number; pages: SandboxPage[] }
  | { ok: false; reason: "assets" | "sandbox" | "parse" | "too_many_pages" };

const REQUEST_TIMEOUT_MS = 20_000;
const FRAME_LOAD_TIMEOUT_MS = 10_000;
const LIB_TIMEOUT_MS = 20_000;
const MAX_PAGES = 200;
const MAX_TEXT_ITEMS = 20_000;
const MAX_TEXT_CHARS = 2_000;

// Transferred with the library. `kind`/`filename` are exactly what pdf.js asks
// its BinaryDataFactory for; `path` must match scripts/vendor-pdfjs.mjs.
const EAGER_BINARY = [
  { kind: "wasmUrl", filename: "jbig2.wasm", path: "wasm/jbig2.wasm", wasm: true },
  { kind: "wasmUrl", filename: "openjpeg.wasm", path: "wasm/openjpeg.wasm", wasm: true },
  { kind: "standardFontDataUrl", filename: "FoxitSymbol.pfb", path: "standard_fonts/FoxitSymbol.pfb", wasm: false },
  { kind: "standardFontDataUrl", filename: "FoxitDingbats.pfb", path: "standard_fonts/FoxitDingbats.pfb", wasm: false },
] as const;
// Served on request. Same pattern and cap as scripts/vendor-pdfjs.mjs.
const CMAP_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}\.bcmap$/;
const MAX_CMAP_BYTES = 1_000_000;
const MAX_DATA_REQUESTS = 400; // per sandbox; pdfjs-dist ships 169 CMaps

// The frame's whole program. No network (CSP), no same-origin access (sandbox
// without allow-same-origin), and it accepts exactly one init message from its
// parent carrying the port; all later traffic uses that port. Kept free of
// backticks and template placeholders, and it must never contain the pdf.js
// worker or editor class names (build check, addendum C20).
const SANDBOX_SCRIPT = `
(function () {
  "use strict";
  var port = null;
  var lib = null;
  var doc = null;
  var tasks = new Map();
  var binary = null;
  var dataWaiters = new Map();
  var nextDataId = 1;
  var checkedPages = new Set();
  // pdf.js calls new BinaryDataFactory(urls).fetch({ kind, filename }) whenever
  // the worker needs wasm, a standard font or a CMap (useWorkerFetch is false).
  // Answer from the bytes the parent transferred, or ask the parent for a CMap.
  function MemoryBinaryData() {}
  MemoryBinaryData.prototype.fetch = function (req) {
    var kind = req && req.kind;
    var name = req && req.filename;
    var table = binary && typeof kind === "string" ? binary[kind] : null;
    var bytes = table && typeof name === "string" ? table[name] : null;
    if (bytes instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(bytes.slice(0)));
    if (kind === "cMapUrl" && typeof name === "string") return requestData(kind, name);
    return Promise.reject(new Error("binary data unavailable"));
  };
  function requestData(kind, name) {
    return new Promise(function (resolve, reject) {
      var rid = nextDataId++;
      var timer = setTimeout(function () {
        dataWaiters.delete(rid);
        reject(new Error("binary data timeout"));
      }, 10000);
      dataWaiters.set(rid, { resolve: resolve, reject: reject, timer: timer });
      send({ type: "data", rid: rid, kind: kind, filename: name });
    });
  }
  function onData(m) {
    var w = dataWaiters.get(m.rid);
    if (!w) return;
    dataWaiters.delete(m.rid);
    clearTimeout(w.timer);
    if (m.ok === true && m.bytes instanceof ArrayBuffer) w.resolve(new Uint8Array(m.bytes));
    else w.reject(new Error("binary data unavailable"));
  }
  var OPTIONS = {
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    useSystemFonts: true,
    useWorkerFetch: false,
    useWasm: true,
    BinaryDataFactory: MemoryBinaryData,
    maxImageSize: 25000000,
    canvasMaxAreaInBytes: 64000000,
    stopAtErrors: false,
    verbosity: 0
  };
  function send(msg, transfer) {
    if (!port) return;
    try { port.postMessage(msg, transfer || []); } catch (e) {}
  }
  function crash() { send({ type: "crash" }); }
  function fail(id, error) { send({ type: "result", id: id, ok: false, error: error }); }
  window.addEventListener("error", crash);
  window.addEventListener("message", function (e) {
    if (port || e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.type !== "gbtn-pdf-init" || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = function (ev) {
      Promise.resolve(ev.data).then(handle).catch(crash);
    };
  });
  function probeWorker(url) {
    return new Promise(function (resolve) {
      var w;
      try { w = new Worker(url, { type: "module" }); } catch (e) { resolve(null); return; }
      var done = false;
      var timer = setTimeout(function () { finish(false); }, 8000);
      function onMessage() { finish(true); }
      function onError(ev) { if (ev && ev.preventDefault) ev.preventDefault(); finish(false); }
      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        if (!ok) { try { w.terminate(); } catch (e) {} }
        resolve(ok ? w : null);
      }
      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);
    });
  }
  async function loadLib(m) {
    try {
      var table = Object.create(null);
      var list = Array.isArray(m.binary) ? m.binary : [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b || typeof b.kind !== "string" || typeof b.filename !== "string" || !(b.bytes instanceof ArrayBuffer)) continue;
        if (!table[b.kind]) table[b.kind] = Object.create(null);
        table[b.kind][b.filename] = b.bytes;
      }
      binary = table;
      var libUrl = URL.createObjectURL(new Blob([m.lib], { type: "text/javascript" }));
      var workerUrl = URL.createObjectURL(new Blob([m.worker], { type: "text/javascript" }));
      lib = await import(libUrl);
      var w = await probeWorker(workerUrl);
      if (w) {
        w.addEventListener("error", crash);
        lib.GlobalWorkerOptions.workerPort = w;
      } else {
        lib.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      send({ type: "lib", ok: true });
    } catch (e) {
      lib = null;
      send({ type: "lib", ok: false });
    }
  }
  async function openDoc(m) {
    if (!lib) return fail(m.id, "sandbox");
    if (doc) {
      var old = doc;
      doc = null;
      try { await old.destroy(); } catch (e) {}
    }
    var next;
    try {
      next = await lib.getDocument(Object.assign({ data: new Uint8Array(m.data) }, OPTIONS)).promise;
    } catch (e) {
      return fail(m.id, "parse");
    }
    if (next.numPages > 200) {
      try { await next.destroy(); } catch (e) {}
      return fail(m.id, "too_many_pages");
    }
    try {
      var pages = [];
      for (var i = 1; i <= next.numPages; i++) {
        var p = await next.getPage(i);
        pages.push({
          index: i - 1,
          view: Array.prototype.slice.call(p.view, 0, 4).map(Number),
          rotate: Number(p.rotate)
        });
      }
      checkedPages = new Set();
      doc = next;
      send({ type: "result", id: m.id, ok: true, value: { numPages: next.numPages, pages: pages } });
    } catch (e) {
      try { await next.destroy(); } catch (e2) {}
      fail(m.id, "parse");
    }
  }
  // Backstop for images pdf.js could not decode. The worker only logs the
  // failure and resolves the image object to null, and the canvas then skips
  // it, so the render promise resolves with a blank area. Resolves true only
  // when every image object the page paints resolved to real data.
  function objReady(page, id) {
    return new Promise(function (resolve) {
      try {
        var store = id.indexOf("g_") === 0 ? page.commonObjs : page.objs;
        store.get(id, function (data) { resolve(data !== null && data !== undefined); });
      } catch (e) {
        resolve(false);
      }
    });
  }
  async function imagesResolved(page, task) {
    // The render's own operator list, so the images are not decoded twice. The
    // public call is the fallback if that internal field ever goes away.
    var list = null;
    try { list = task._internalRenderTask.operatorList; } catch (e) { list = null; }
    if (!list || list.lastChunk !== true || !Array.isArray(list.fnArray) || !Array.isArray(list.argsArray)) {
      list = await page.getOperatorList({ annotationMode: lib.AnnotationMode.ENABLE });
    }
    var OPS = lib.OPS;
    var seen = new Set();
    var waits = [];
    for (var i = 0; i < list.fnArray.length; i++) {
      var fn = list.fnArray[i];
      var args = list.argsArray[i];
      var id;
      if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
        id = args ? args[0] : null;
        if (typeof id !== "string") return false;
      } else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat) {
        id = args && args[0] ? args[0].data : null;
        if (typeof id !== "string") continue; // mask data travels inline in the op
      } else {
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      waits.push(objReady(page, id));
    }
    if (waits.length === 0) return true;
    var timer = null;
    var timeout = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve([false]); }, 10000);
    });
    var results = await Promise.race([Promise.all(waits), timeout]);
    clearTimeout(timer);
    return results.every(function (ok) { return ok === true; });
  }
  async function renderPage(m) {
    if (!doc) return fail(m.id, "sandbox");
    var current = doc;
    var prev = tasks.get(m.index);
    if (prev) {
      prev.cancelled = true;
      if (prev.task) { try { prev.task.cancel(); } catch (e) {} }
    }
    var entry = { id: m.id, task: null, cancelled: false };
    tasks.set(m.index, entry);
    var canvas = document.createElement("canvas");
    try {
      var page = await doc.getPage(m.index + 1);
      if (entry.cancelled) return fail(m.id, "cancelled");
      var base = page.getViewport({ scale: 1 });
      var scale = Number(m.scale);
      if (!(scale > 0) || !isFinite(scale)) scale = 1;
      var maxScale = Math.sqrt(16000000 / Math.max(1, base.width * base.height));
      scale = Math.max(0.05, Math.min(scale, maxScale, 10));
      var viewport = page.getViewport({ scale: scale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      entry.task = page.render({
        canvas: canvas,
        viewport: viewport,
        annotationMode: lib.AnnotationMode.ENABLE
      });
      await entry.task.promise;
      if (entry.cancelled) return fail(m.id, "cancelled");
      if (!checkedPages.has(m.index)) {
        var imagesOk = await imagesResolved(page, entry.task);
        if (entry.cancelled) return fail(m.id, "cancelled");
        if (!imagesOk) return fail(m.id, "render");
        if (doc === current) checkedPages.add(m.index);
      }
      var bitmap = await createImageBitmap(canvas);
      send({ type: "result", id: m.id, ok: true, value: bitmap }, [bitmap]);
    } catch (e) {
      fail(m.id, entry.cancelled || (e && e.name === "RenderingCancelledException") ? "cancelled" : "render");
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      if (tasks.get(m.index) === entry) tasks.delete(m.index);
    }
  }
  async function pageText(m) {
    if (!doc) return fail(m.id, "sandbox");
    try {
      var page = await doc.getPage(m.index + 1);
      var content = await page.getTextContent({ includeMarkedContent: false });
      var items = [];
      for (var i = 0; i < content.items.length && items.length < 20000; i++) {
        var it = content.items[i];
        if (!it || typeof it.str !== "string") continue;
        items.push({
          str: it.str.slice(0, 2000),
          dir: String(it.dir),
          transform: Array.prototype.slice.call(it.transform || [], 0, 6).map(Number),
          width: Number(it.width),
          height: Number(it.height),
          hasEOL: it.hasEOL === true
        });
      }
      send({ type: "result", id: m.id, ok: true, value: items });
    } catch (e) {
      fail(m.id, "text");
    }
  }
  async function handle(m) {
    if (!m || typeof m.type !== "string") return;
    if (m.type === "lib") return loadLib(m);
    if (m.type === "data") return onData(m);
    if (m.type === "cancel") {
      var t = tasks.get(m.index);
      if (t) {
        t.cancelled = true;
        if (t.task) { try { t.task.cancel(); } catch (e) {} }
      }
      return;
    }
    if (m.type === "open") return openDoc(m);
    if (m.type === "render") return renderPage(m);
    if (m.type === "text") return pageText(m);
  }
})();
`;

const SANDBOX_HTML =
  '<!doctype html><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'wasm-unsafe-eval\' blob:; worker-src blob:; img-src blob: data:; font-src blob: data:; style-src \'unsafe-inline\'; connect-src blob: data:">' +
  `<script>${SANDBOX_SCRIPT}</script>`;

// ── fetch + verify ─────────────────────────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch bytes without cookies or a Referer, bounded by maxBytes, and accept
 * them only when their SHA-256 equals the hash the server snapshotted.
 */
export async function fetchVerified(
  url: string,
  expectedSha256: string,
  opts?: { maxBytes?: number }
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: "fetch" | "hash" | "too_large" }> {
  const maxBytes = opts?.maxBytes ?? Number.POSITIVE_INFINITY;
  const expected = expectedSha256.trim().toLowerCase();
  let res: Response;
  try {
    res = await fetch(url, { credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  } catch {
    return { ok: false, reason: "fetch" };
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "fetch" };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: "too_large" };
  }

  let bytes: Uint8Array;
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      const whole = new Uint8Array(await res.arrayBuffer());
      if (whole.byteLength > maxBytes) return { ok: false, reason: "too_large" };
      bytes = whole;
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, reason: "too_large" };
        }
        chunks.push(value);
      }
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bytes = joined;
    }
  } catch {
    return { ok: false, reason: "fetch" };
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !/^[0-9a-f]{64}$/.test(expected)) return { ok: false, reason: "hash" };
  try {
    const digest = await subtle.digest("SHA-256", bytes);
    if (toHex(digest) !== expected) return { ok: false, reason: "hash" };
  } catch {
    return { ok: false, reason: "hash" };
  }
  return { ok: true, bytes };
}

// ── vendored library bytes (same-origin, fetched once per page load) ──────

type BinaryEntry = { kind: string; filename: string; bytes: ArrayBuffer };
type LibAssets = { lib: ArrayBuffer; worker: ArrayBuffer; binary: BinaryEntry[] };
let assetsPromise: Promise<LibAssets | "assets" | "fetch"> | null = null;

function isWasm(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return b.length === 4 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
}

async function fetchAsset(path: string): Promise<ArrayBuffer | null> {
  const res = await fetch(`${PDFJS_BASE}/${path}`, { credentials: "same-origin" });
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    return null;
  }
  return res.arrayBuffer();
}

async function loadAssets(): Promise<LibAssets | "assets" | "fetch"> {
  try {
    // A missing prebuild step shows up as a 404 here (addendum C26).
    const head = await fetch(`${PDFJS_BASE}/pdf.js`, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
    if (!head.ok) return "assets";
    const [lib, worker, ...bins] = await Promise.all([
      fetchAsset("pdf.js"),
      fetchAsset("pdf.worker.js"),
      ...EAGER_BINARY.map((b) => fetchAsset(b.path)),
    ]);
    if (!lib || !worker) return "assets";
    const binary: BinaryEntry[] = [];
    for (let i = 0; i < EAGER_BINARY.length; i++) {
      const spec = EAGER_BINARY[i];
      const bytes = bins[i];
      // An older deploy without the binary data, or an HTML 200 in its place.
      if (!bytes || bytes.byteLength === 0 || (spec.wasm && !isWasm(bytes))) return "assets";
      binary.push({ kind: spec.kind, filename: spec.filename, bytes });
    }
    return { lib, worker, binary };
  } catch {
    return "fetch";
  }
}

// Predefined CMaps, fetched same-origin only when the frame asks for one.
const cmapCache = new Map<string, Promise<ArrayBuffer | null>>();

function getCMap(filename: string): Promise<ArrayBuffer | null> {
  let pending = cmapCache.get(filename);
  if (!pending) {
    pending = (async () => {
      try {
        const bytes = await fetchAsset(`cmaps/${filename}`);
        return bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_CMAP_BYTES ? bytes : null;
      } catch {
        return null;
      }
    })();
    cmapCache.set(filename, pending);
    void pending.then((bytes) => {
      if (!bytes) cmapCache.delete(filename); // retry a failure next time
    });
  }
  return pending;
}

function getAssets(): Promise<LibAssets | "assets" | "fetch"> {
  if (!assetsPromise) {
    assetsPromise = loadAssets().then((result) => {
      if (typeof result === "string") assetsPromise = null; // re-check on the next attempt
      return result;
    });
  }
  return assetsPromise;
}

// ── reply validation ───────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function sandboxError(code: string): Error {
  const e = new Error(code);
  e.name = code === "cancelled" ? "RenderingCancelledException" : "PdfSandboxError";
  return e;
}

function parseOpen(value: unknown): { numPages: number; pages: SandboxPage[] } | null {
  if (!isRecord(value)) return null;
  const { numPages, pages } = value;
  if (!isFiniteNumber(numPages) || !Number.isInteger(numPages) || numPages < 1 || numPages > MAX_PAGES) return null;
  if (!Array.isArray(pages) || pages.length !== numPages) return null;
  const out: SandboxPage[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p: unknown = pages[i];
    if (!isRecord(p) || p.index !== i || !isFiniteNumber(p.rotate)) return null;
    const view: unknown = p.view;
    if (!Array.isArray(view) || view.length !== 4) return null;
    const [a, b, c, d] = view as unknown[];
    if (!isFiniteNumber(a) || !isFiniteNumber(b) || !isFiniteNumber(c) || !isFiniteNumber(d)) return null;
    out.push({ index: i, view: [a, b, c, d], rotate: p.rotate });
  }
  return { numPages, pages: out };
}

function parseTextItems(value: unknown): DetectTextItem[] {
  if (!Array.isArray(value)) throw sandboxError("text");
  const out: DetectTextItem[] = [];
  for (const raw of value.slice(0, MAX_TEXT_ITEMS)) {
    if (!isRecord(raw) || typeof raw.str !== "string" || typeof raw.dir !== "string") continue;
    if (!Array.isArray(raw.transform) || raw.transform.length !== 6) continue;
    const transform = (raw.transform as unknown[]).filter(isFiniteNumber);
    if (transform.length !== 6 || !isFiniteNumber(raw.width) || !isFiniteNumber(raw.height)) continue;
    out.push({
      str: raw.str.slice(0, MAX_TEXT_CHARS),
      dir: raw.dir.slice(0, 8),
      transform,
      width: raw.width,
      height: raw.height,
      hasEOL: raw.hasEOL === true,
    });
  }
  return out;
}

// ── host ───────────────────────────────────────────────────────────────────

type Waiter = { resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
type LibStatus = "pending" | "ok" | "assets" | "sandbox";

export class PdfSandbox {
  private readonly iframe: HTMLIFrameElement;
  private readonly port: MessagePort;
  private readonly pending = new Map<number, Waiter>();
  private readonly crashListeners = new Set<() => void>();
  private libStatus: LibStatus = "pending";
  private libWaiter: ((ok: boolean) => void) | null = null;
  private nextId = 1;
  private crashed = false;
  private destroyed = false;

  private constructor(iframe: HTMLIFrameElement, port: MessagePort) {
    this.iframe = iframe;
    this.port = port;
    port.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    port.onmessageerror = () => this.crash();
  }

  /** Appends the hidden sandbox iframe to document.body. Rejects → caller uses its fallback. */
  static async create(): Promise<PdfSandbox> {
    if (typeof document === "undefined" || typeof MessageChannel === "undefined") {
      throw sandboxError("unsupported");
    }
    const assets = getAssets();

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts"); // never allow-same-origin
    iframe.referrerPolicy = "no-referrer";
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:16px;height:16px;border:0;opacity:0";
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(sandboxError("frame_timeout")), FRAME_LOAD_TIMEOUT_MS);
      iframe.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    iframe.srcdoc = SANDBOX_HTML;
    document.body.appendChild(iframe);

    try {
      await loaded;
    } catch (e) {
      iframe.remove();
      throw e;
    }
    const frameWindow = iframe.contentWindow;
    if (!frameWindow) {
      iframe.remove();
      throw sandboxError("frame_window");
    }

    const channel = new MessageChannel();
    const sandbox = new PdfSandbox(iframe, channel.port1);
    try {
      // The frame is an opaque origin, so "*" is the only usable target; the
      // frame accepts the init only from its parent window.
      frameWindow.postMessage({ type: "gbtn-pdf-init" }, "*", [channel.port2]);
    } catch (e) {
      sandbox.destroy();
      throw e;
    }

    const lib = await assets;
    if (lib === "fetch") {
      sandbox.destroy();
      throw sandboxError("assets_fetch");
    }
    if (lib === "assets") {
      sandbox.libStatus = "assets";
      return sandbox;
    }
    sandbox.libStatus = (await sandbox.loadLib(lib)) ? "ok" : "sandbox";
    return sandbox;
  }

  /** Transfers a COPY of the bytes; the caller's array stays intact. */
  async open(bytes: Uint8Array): Promise<SandboxOpenResult> {
    if (this.libStatus === "assets") return { ok: false, reason: "assets" };
    if (this.libStatus !== "ok" || this.crashed || this.destroyed) return { ok: false, reason: "sandbox" };
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    let value: unknown;
    try {
      value = await this.request({ type: "open", data: copy }, [copy]);
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      if (code === "parse") return { ok: false, reason: "parse" };
      if (code === "too_many_pages") return { ok: false, reason: "too_many_pages" };
      return { ok: false, reason: "sandbox" };
    }
    const parsed = parseOpen(value);
    return parsed ? { ok: true, ...parsed } : { ok: false, reason: "sandbox" };
  }

  /** Rejects on cancel (name "RenderingCancelledException") or any error. */
  async renderPage(index: number, scale: number): Promise<ImageBitmap> {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PAGES || !isFiniteNumber(scale) || scale <= 0) {
      throw sandboxError("bad_args");
    }
    const value = await this.request({ type: "render", index, scale });
    if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) return value;
    if (isRecord(value) && typeof value.close === "function") {
      try {
        (value as { close: () => void }).close();
      } catch {
        // not a bitmap after all
      }
    }
    throw sandboxError("render");
  }

  cancel(index: number): void {
    if (this.destroyed || this.crashed || !Number.isInteger(index)) return;
    try {
      this.port.postMessage({ type: "cancel", index });
    } catch {
      // port already closed
    }
  }

  async getText(index: number): Promise<DetectTextItem[]> {
    if (!Number.isInteger(index) || index < 0 || index >= MAX_PAGES) throw sandboxError("bad_args");
    return parseTextItems(await this.request({ type: "text", index }));
  }

  /** Frame error, worker error, or a request unanswered for 20 s. Returns an unsubscribe. */
  onCrash(cb: () => void): () => void {
    if (this.crashed) {
      queueMicrotask(() => {
        if (!this.destroyed) cb();
      });
      return () => undefined;
    }
    this.crashListeners.add(cb);
    return () => {
      this.crashListeners.delete(cb);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.crashListeners.clear();
    this.rejectAll("destroyed");
    this.libWaiter?.(false);
    this.port.onmessage = null;
    try {
      this.port.close();
    } catch {
      // already closed
    }
    this.iframe.remove();
  }

  // ── internals ──

  private dataRequests = 0;

  /**
   * The frame asks for a predefined CMap by pdf.js filename. Only names of the
   * vendored shape are fetched, only from the vendored cmaps/ directory, and
   * only up to MAX_DATA_REQUESTS per sandbox; anything else gets ok:false.
   */
  private async serveData(data: Record<string, unknown>): Promise<void> {
    const rid = data.rid;
    if (typeof rid !== "number" || !Number.isInteger(rid)) return;
    let bytes: ArrayBuffer | null = null;
    const filename = data.filename;
    if (
      data.kind === "cMapUrl" &&
      typeof filename === "string" &&
      CMAP_NAME.test(filename) &&
      this.dataRequests < MAX_DATA_REQUESTS
    ) {
      this.dataRequests += 1;
      const cached = await getCMap(filename);
      if (cached) bytes = cached.slice(0);
    }
    if (this.destroyed || this.crashed) return;
    try {
      if (bytes) this.port.postMessage({ type: "data", rid, ok: true, bytes }, [bytes]);
      else this.port.postMessage({ type: "data", rid, ok: false });
    } catch {
      // port already closed
    }
  }

  private loadLib(assets: LibAssets): Promise<boolean> {
    return new Promise((resolve) => {
      const lib = assets.lib.slice(0);
      const worker = assets.worker.slice(0);
      const binary = assets.binary.map((b) => ({ kind: b.kind, filename: b.filename, bytes: b.bytes.slice(0) }));
      const timer = setTimeout(() => {
        this.libWaiter = null;
        resolve(false);
      }, LIB_TIMEOUT_MS);
      this.libWaiter = (ok) => {
        clearTimeout(timer);
        this.libWaiter = null;
        resolve(ok);
      };
      try {
        this.port.postMessage({ type: "lib", lib, worker, binary }, [lib, worker, ...binary.map((b) => b.bytes)]);
      } catch {
        this.libWaiter?.(false);
      }
    });
  }

  private request(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (this.destroyed || this.crashed) return Promise.reject(sandboxError("sandbox"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(sandboxError("timeout"));
        this.crash();
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.port.postMessage({ ...message, id }, transfer);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(sandboxError("sandbox"));
      }
    });
  }

  private handleMessage(data: unknown): void {
    if (this.destroyed || !isRecord(data)) return;
    if (data.type === "crash") {
      this.crash();
      return;
    }
    if (data.type === "lib") {
      this.libWaiter?.(data.ok === true);
      return;
    }
    if (data.type === "data") {
      void this.serveData(data);
      return;
    }
    if (data.type !== "result" || typeof data.id !== "number") return;
    const waiter = this.pending.get(data.id);
    if (!waiter) {
      // A late reply to a timed-out or cancelled request: free any bitmap.
      if (typeof ImageBitmap !== "undefined" && data.value instanceof ImageBitmap) data.value.close();
      return;
    }
    this.pending.delete(data.id);
    clearTimeout(waiter.timer);
    if (data.ok === true) waiter.resolve(data.value);
    else waiter.reject(sandboxError(typeof data.error === "string" ? data.error.slice(0, 40) : "error"));
  }

  private rejectAll(code: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(sandboxError(code));
    }
  }

  private crash(): void {
    if (this.crashed || this.destroyed) return;
    this.crashed = true;
    this.libWaiter?.(false);
    this.rejectAll("sandbox");
    for (const cb of Array.from(this.crashListeners)) {
      try {
        cb();
      } catch {
        // a listener's failure must not stop the others
      }
    }
  }
}
