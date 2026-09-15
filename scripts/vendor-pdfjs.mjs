// Copies the pinned pdfjs-dist legacy build into public/vendor/pdfjs/<version>/
// so the e-sign pdf.js sandbox (components/esign/pdf-sandbox.ts) can fetch it
// same-origin and hand it to its sandboxed iframe. pdf.js never enters the
// webpack graph. Runs automatically as npm's predev and prebuild hooks.
//
// LOCAL FILE COPY ONLY. Unlike the one-offs elsewhere in scripts/, this reads
// node_modules and writes public/vendor/pdfjs/ — no network, no .env, no
// database. Safe to run anywhere.
//
// .mjs -> .js so every static host serves a JavaScript MIME type (module
// workers are refused on application/octet-stream). The sandbox has no network,
// so the parent fetches the binary data below and hands it to pdf.js in memory:
//   wasm/            jbig2.wasm (JBIG2 + CCITT G4) and openjpeg.wasm (JPX). No
//                    JS decoder remains for those filters, so without these a
//                    scanned page renders blank. Transferred with the library.
//   standard_fonts/  FoxitSymbol + FoxitDingbats, the two standard fonts that
//                    useSystemFonts cannot substitute. Transferred with it too.
//   cmaps/           the predefined CMaps some CJK PDFs need; served on request.
// Not copied: qcms_bg.wasm and iccs/ (pdf.js 6.3.289 disables ICC colour when
// useWorkerFetch is false and falls back to the alternate colour space),
// quickjs-eval (no scripting), the *_nowasm_fallback.js decoders (they load via
// import() of a URL, which the sandbox cannot do), and the other standard fonts.
// The output is ignored by public/vendor/.gitignore; never commit it.
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED = "6.3.289"; // must equal PDFJS_VERSION in components/esign/pdf-sandbox.ts

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "pdfjs-dist");

const { version } = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8"));
if (version !== PINNED) {
  throw new Error(
    `pdfjs-dist ${version} is installed but ${PINNED} is pinned. ` +
      "Reinstall the pinned version, or change PINNED and PDFJS_VERSION together."
  );
}

// [source in pdfjs-dist, destination under public/vendor/pdfjs/<version>/].
// The wasm and standard_fonts paths must match EAGER_BINARY in pdf-sandbox.ts.
const FILES = [
  ["legacy/build/pdf.min.mjs", "pdf.js"],
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.js"],
  ["wasm/jbig2.wasm", "wasm/jbig2.wasm"],
  ["wasm/openjpeg.wasm", "wasm/openjpeg.wasm"],
  ["wasm/LICENSE_JBIG2", "wasm/LICENSE_JBIG2"],
  ["wasm/LICENSE_PDFJS_JBIG2", "wasm/LICENSE_PDFJS_JBIG2"],
  ["wasm/LICENSE_OPENJPEG", "wasm/LICENSE_OPENJPEG"],
  ["wasm/LICENSE_PDFJS_OPENJPEG", "wasm/LICENSE_PDFJS_OPENJPEG"],
  ["standard_fonts/FoxitSymbol.pfb", "standard_fonts/FoxitSymbol.pfb"],
  ["standard_fonts/FoxitDingbats.pfb", "standard_fonts/FoxitDingbats.pfb"],
  ["standard_fonts/LICENSE_FOXIT", "standard_fonts/LICENSE_FOXIT"],
  ["cmaps/LICENSE", "cmaps/LICENSE"],
];
const WASM = new Set(["wasm/jbig2.wasm", "wasm/openjpeg.wasm"]);

// Must match CMAP_NAME in pdf-sandbox.ts, which only serves names of this shape.
const CMAP_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}\.bcmap$/;
const CMAP_MAX_BYTES = 1_000_000; // MAX_CMAP_BYTES in pdf-sandbox.ts

// Fail loudly before deleting anything.
for (const [from] of FILES) {
  const path = join(pkgDir, from);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`[vendor-pdfjs] ${from} is missing or empty.`);
  if (WASM.has(from)) {
    const head = (await readFile(path)).subarray(0, 4);
    if (head.length !== 4 || head[0] !== 0x00 || head[1] !== 0x61 || head[2] !== 0x73 || head[3] !== 0x6d) {
      throw new Error(`[vendor-pdfjs] ${from} is not a WebAssembly module.`);
    }
  }
}
const cmaps = (await readdir(join(pkgDir, "cmaps"))).filter((name) => name.endsWith(".bcmap"));
if (cmaps.length === 0 || !cmaps.includes("UniJIS-UCS2-H.bcmap")) {
  throw new Error("[vendor-pdfjs] pdfjs-dist/cmaps has no predefined CMaps.");
}
for (const name of cmaps) {
  if (!CMAP_NAME.test(name)) {
    throw new Error(`[vendor-pdfjs] CMap ${name} does not match CMAP_NAME; widen it in both files.`);
  }
  const { size } = await stat(join(pkgDir, "cmaps", name));
  if (size === 0 || size > CMAP_MAX_BYTES) {
    throw new Error(`[vendor-pdfjs] CMap ${name} is ${size} bytes, outside 1..${CMAP_MAX_BYTES}.`);
  }
}

const vendorRoot = join(root, "public", "vendor", "pdfjs");
const out = join(vendorRoot, PINNED);
await rm(vendorRoot, { recursive: true, force: true });
for (const dir of ["wasm", "standard_fonts", "cmaps"]) {
  await mkdir(join(out, dir), { recursive: true });
}
for (const [from, to] of FILES) {
  await copyFile(join(pkgDir, from), join(out, to));
}
for (const name of cmaps) {
  await copyFile(join(pkgDir, "cmaps", name), join(out, "cmaps", name));
}

console.log(
  `[vendor-pdfjs] pdfjs-dist ${PINNED} -> public/vendor/pdfjs/${PINNED}/ ` +
    `(pdf.js, pdf.worker.js, 2 wasm decoders, 2 standard fonts, ${cmaps.length} CMaps)`
);
