/**
 * Shrink oversized images before they reach the model.
 *
 * Deliberately narrow in scope: a pixel + byte budget, decompression-bomb guards,
 * a lossless-first / JPEG-ladder encode strategy, and a best-effort contract (any
 * decode/encode failure returns the original bytes unchanged, `changed: false`).
 * Out of scope: WebP wasm decoding (WebP/GIF pass through here), region readback,
 * DI config ownership, and telemetry. `jimp` is imported lazily so the codec is
 * only paid for when an image actually needs work.
 *
 * Compression is never silent to the model: the result carries the original
 * dimensions so the caller can annotate "you are looking at a downsampled copy".
 */

/** Built-in longest-edge ceiling (px). Larger images are scaled down to fit. */
export const MAX_IMAGE_EDGE_PX = 2000;

/** Env override for the longest-edge ceiling (px). Ignored unless a positive int. */
export const MAX_IMAGE_EDGE_ENV = "AGENTS_IMAGE_MAX_EDGE_PX";

/**
 * Raw-byte budget for images the model reads for itself (Read's image path). A
 * session that keeps screenshotting accumulates every image in the request body
 * on every turn, so per-image size — not the provider's per-image ceiling — is
 * what keeps the total under the request-size limit. 256 KB keeps a clean 2000px
 * UI screenshot on the lossless fast path while capping dense content at a
 * readable q80/1000px JPEG.
 */
export const READ_IMAGE_BYTE_BUDGET = 256 * 1024;

/** Env override for the read-image byte budget (bytes). Ignored unless a positive int. */
export const READ_IMAGE_BYTE_BUDGET_ENV = "AGENTS_IMAGE_READ_BYTE_BUDGET";

/** Progressively lower JPEG quality until the payload fits the byte budget. */
const JPEG_QUALITY_STEPS = [80, 60, 40, 20] as const;

/**
 * Longest-edge step-downs tried when the budget cannot be met at the fitted
 * size. With the built-in 2000px ceiling the first step is a no-op; the
 * sub-1000px tail lets even entropy-upper-bound content (noise, photos) land
 * within a read-scale budget of a few tens of KB.
 */
const FALLBACK_EDGES_PX = [2000, 1000, 768, 512, 384, 256] as const;

/**
 * PNG rescales stop at this edge; below it the ladder goes lossy. For a
 * text-bearing screenshot a q80 JPEG at 1000px reads better than a lossless PNG
 * at 512px — resolution beats losslessness once both are degraded.
 */
const PNG_RESCALE_FLOOR_PX = 1000;

/**
 * Pixel-count ceiling above which compression is skipped entirely. A tiny-byte,
 * huge-dimension image (e.g. a solid 30000×30000 PNG) would otherwise be fully
 * decoded into a multi-gigabyte bitmap before any resize — a decompression-bomb
 * OOM vector the byte budget alone never catches. The header sniff gives us the
 * dimensions without decoding, so we gate on them first.
 */
const MAX_DECODE_PIXELS = 100_000_000;

/**
 * Raw-byte ceiling above which compression is skipped rather than decoded. The
 * byte budget bounds the output, but the compressor still has to load the input
 * first; this bounds that input allocation.
 */
export const MAX_IMAGE_DECODE_BYTES = 64 * 1024 * 1024;

/** Formats we can decode and re-encode. Everything else passes through. */
const RECODABLE_MIME = new Set(["image/png", "image/jpeg"]);

function positiveIntFromEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveMaxImageEdgePx(): number {
  return positiveIntFromEnv(MAX_IMAGE_EDGE_ENV) ?? MAX_IMAGE_EDGE_PX;
}

export function resolveReadImageByteBudget(): number {
  return positiveIntFromEnv(READ_IMAGE_BYTE_BUDGET_ENV) ?? READ_IMAGE_BYTE_BUDGET;
}

function normalizeImageMime(mimeType: string): string {
  const bare = mimeType.split(";")[0]!.trim().toLowerCase();
  return bare === "image/jpg" ? "image/jpeg" : bare;
}

export interface CompressImageOptions {
  /** Override the longest-edge ceiling (px). Defaults to {@link resolveMaxImageEdgePx}. */
  readonly maxEdge?: number;
  /** Override the raw-byte budget. Defaults to {@link resolveReadImageByteBudget}. */
  readonly byteBudget?: number;
  /** Override the raw-byte ceiling above which compression is skipped. */
  readonly maxDecodeBytes?: number;
}

export interface CompressImageResult {
  /** Bytes to send: the re-encoded image, or the original when unchanged. */
  readonly data: Uint8Array;
  /** MIME of `data`. May differ from the input (e.g. png → jpeg). */
  readonly mimeType: string;
  /** Pixel width of `data`; 0 when unknown. */
  readonly width: number;
  /** Pixel height of `data`; 0 when unknown. */
  readonly height: number;
  /** Pixel width of the input image (decoded width when re-encoded, else header sniff, 0 when unknown). */
  readonly originalWidth: number;
  /** Pixel height of the input image; see {@link originalWidth}. */
  readonly originalHeight: number;
  /** True only when `data` differs from the input bytes. */
  readonly changed: boolean;
  readonly originalByteLength: number;
  readonly finalByteLength: number;
}

/**
 * Downsample/re-encode `bytes` to fit the pixel + byte budget. Never throws: on
 * any failure (unsupported format, decode error, a result no smaller than the
 * input) the original bytes are returned with `changed: false`.
 */
export async function compressImageForModel(
  bytes: Uint8Array,
  mimeType: string,
  options: CompressImageOptions = {},
): Promise<CompressImageResult> {
  const maxEdge = options.maxEdge ?? resolveMaxImageEdgePx();
  const byteBudget = options.byteBudget ?? resolveReadImageByteBudget();
  const maxDecodeBytes = options.maxDecodeBytes ?? MAX_IMAGE_DECODE_BYTES;
  const normalizedMime = normalizeImageMime(mimeType);
  const dims = sniffDimensions(bytes);

  const passthrough = (): CompressImageResult => ({
    data: bytes,
    mimeType,
    width: dims?.width ?? 0,
    height: dims?.height ?? 0,
    originalWidth: dims?.width ?? 0,
    originalHeight: dims?.height ?? 0,
    changed: false,
    originalByteLength: bytes.length,
    finalByteLength: bytes.length,
  });

  if (bytes.length === 0) return passthrough();
  if (!RECODABLE_MIME.has(normalizedMime)) return passthrough();

  // Fast path: already within both budgets — no codec load, no allocation.
  const longestEdge = dims ? Math.max(dims.width, dims.height) : 0;
  const withinBytes = bytes.length <= byteBudget;
  const withinEdge = longestEdge > 0 && longestEdge <= maxEdge;
  if (withinBytes && (withinEdge || longestEdge === 0)) return passthrough();

  // Decompression-bomb guards: refuse to decode absurd pixel counts or byte
  // payloads. The sniff above gave us the dimensions without decoding.
  if (dims && dims.width * dims.height > MAX_DECODE_PIXELS) return passthrough();
  if (bytes.length > maxDecodeBytes) return passthrough();

  try {
    const { Jimp } = await import("jimp");
    const image = await Jimp.fromBuffer(Buffer.from(bytes));
    const preferLossless = normalizedMime !== "image/jpeg";
    const decodedWidth = image.width;
    const decodedHeight = image.height;

    fitWithinEdge(image, maxEdge);
    const encoded = await encodeWithinBudget(image, { preferLossless, byteBudget });

    // Keep the result only when it actually helps: fewer bytes, or fewer pixels
    // (a smaller image costs fewer vision tokens even if the byte count is flat).
    const shrankBytes = encoded.data.length < bytes.length;
    const shrankPixels = encoded.width * encoded.height < decodedWidth * decodedHeight;
    if (!shrankBytes && !shrankPixels) return passthrough();

    return {
      data: encoded.data,
      mimeType: encoded.mimeType,
      width: encoded.width,
      height: encoded.height,
      originalWidth: decodedWidth,
      originalHeight: decodedHeight,
      changed: true,
      originalByteLength: bytes.length,
      finalByteLength: encoded.data.length,
    };
  } catch {
    return passthrough();
  }
}

type JimpImage = Awaited<ReturnType<(typeof import("jimp"))["Jimp"]["fromBuffer"]>>;

interface EncodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

interface EncodeOptions {
  readonly preferLossless: boolean;
  readonly byteBudget: number;
}

/**
 * Encode `image` (already fitted to the edge ceiling) under the byte budget.
 * PNG source: PNG at the fitted size → smaller PNG rescales to the floor → JPEG
 * ladder at that size → JPEG ladder at each sub-floor edge. JPEG source: the
 * quality ladder at the fitted size, then again at each fallback rescale.
 */
async function encodeWithinBudget(image: JimpImage, opts: EncodeOptions): Promise<EncodedImage> {
  const { preferLossless, byteBudget } = opts;
  let smallest: EncodedImage | null = null;

  const consider = (data: Buffer, mimeType: string): EncodedImage => {
    const candidate: EncodedImage = { data, mimeType, width: image.width, height: image.height };
    if (smallest === null || candidate.data.length < smallest.data.length) smallest = candidate;
    return candidate;
  };

  const jpegLadder = async (): Promise<EncodedImage | null> => {
    for (const quality of JPEG_QUALITY_STEPS) {
      const jpeg = await image.getBuffer("image/jpeg", { quality });
      if (jpeg.length <= byteBudget) return consider(jpeg, "image/jpeg");
      consider(jpeg, "image/jpeg");
    }
    return null;
  };

  if (preferLossless) {
    const png = await image.getBuffer("image/png");
    if (png.length <= byteBudget) return consider(png, "image/png");
    consider(png, "image/png");

    for (const edge of FALLBACK_EDGES_PX) {
      if (edge < PNG_RESCALE_FLOOR_PX) break;
      if (!fitWithinEdge(image, edge)) continue;
      const smallerPng = await image.getBuffer("image/png");
      if (smallerPng.length <= byteBudget) return consider(smallerPng, "image/png");
      consider(smallerPng, "image/png");
    }

    const atFloor = await jpegLadder();
    if (atFloor !== null) return atFloor;
    for (const edge of FALLBACK_EDGES_PX) {
      if (edge >= PNG_RESCALE_FLOOR_PX) continue;
      if (!fitWithinEdge(image, edge)) continue;
      const atEdge = await jpegLadder();
      if (atEdge !== null) return atEdge;
    }
    return smallest!;
  }

  const atFitted = await jpegLadder();
  if (atFitted !== null) return atFitted;
  for (const edge of FALLBACK_EDGES_PX) {
    if (!fitWithinEdge(image, edge)) continue;
    const atEdge = await jpegLadder();
    if (atEdge !== null) return atEdge;
  }
  return smallest!;
}

/**
 * Scale `image` so its longest edge is at most `edge`, preserving aspect ratio.
 * No-op (returns false) when the image already fits. Passes no `mode`: jimp's
 * default resizer downscales with a full-coverage area average that does not
 * alias — do not "upgrade" this to a named ResizeStrategy.
 */
function fitWithinEdge(image: JimpImage, edge: number): boolean {
  const longest = Math.max(image.width, image.height);
  if (longest <= edge) return false;
  const factor = edge / longest;
  image.resize({
    w: Math.max(1, Math.round(image.width * factor)),
    h: Math.max(1, Math.round(image.height * factor)),
  });
  return true;
}

/** Header-only dimension sniff for PNG/JPEG (no decode). Returns null if unknown. */
function sniffDimensions(data: Uint8Array): { readonly width: number; readonly height: number } | null {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (
    buf.length >= 24 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return sniffJpeg(buf);
}

function sniffJpeg(data: Buffer): { readonly width: number; readonly height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}
