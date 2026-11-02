import { AppError } from './app-error';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

interface ImageType {
  contentType: string;
  extension: string;
}

const SIGNATURES: Array<ImageType & { matches: (b: Buffer) => boolean }> = [
  { contentType: 'image/jpeg', extension: 'jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    contentType: 'image/png',
    extension: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    contentType: 'image/webp',
    extension: 'webp',
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * Identifies the image by its first bytes ("magic numbers"). The file name and the
 * Content-Type header come from the client and can be faked, so they are ignored.
 */
export function detectImageType(buffer: Buffer): ImageType | null {
  if (buffer.length < 12) {
    return null;
  }

  const match = SIGNATURES.find((signature) => signature.matches(buffer));
  return match ? { contentType: match.contentType, extension: match.extension } : null;
}

/**
 * Checks an upload and returns the bytes to store: the same image without its metadata.
 * A phone photo carries GPS coordinates, the device and the capture time in EXIF, and every
 * user with access to the catalog would download them with the photo.
 */
export function requireImage(file: Express.Multer.File): ImageType & { body: Buffer } {
  const type = detectImageType(file.buffer);
  const body = type && stripMetadata(file.buffer, type.contentType);

  if (!type || !body) {
    throw new AppError(400, 'INVALID_IMAGE', 'Only JPEG, PNG or WebP images are accepted');
  }

  return { ...type, body };
}

/** The image without EXIF, XMP, IPTC or text metadata, or null if its structure does not parse. */
export function stripMetadata(buffer: Buffer, contentType: string): Buffer | null {
  try {
    if (contentType === 'image/jpeg') return stripJpeg(buffer);
    if (contentType === 'image/png') return stripPng(buffer);
    if (contentType === 'image/webp') return stripWebp(buffer);
  } catch {
    // A length that points past the end of the file throws RangeError: not a well-formed image.
  }
  return null;
}

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const COM = 0xfe;

/**
 * Keeps every segment the decoder needs, plus JFIF (APP0), the color profile (APP2 ICC_PROFILE)
 * and Adobe's color transform (APP14). Drops the other APPn segments (EXIF, XMP, IPTC, maker
 * notes) and comments. EXIF is replaced by one holding only the orientation, so a photo taken
 * sideways still displays upright.
 */
function stripJpeg(buffer: Buffer): Buffer | null {
  if (buffer[0] !== 0xff || buffer[1] !== SOI) return null;
  const parts: Buffer[] = [buffer.subarray(0, 2)];
  let offset = 2;

  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    while (buffer[offset + 1] === 0xff) offset += 1; // fill bytes before a marker
    const marker = buffer[offset + 1];
    if (marker === SOS) {
      // Compressed image data follows; it holds no metadata, so it is copied as is.
      parts.push(buffer.subarray(offset));
      return Buffer.concat(parts);
    }
    if (marker === EOI || marker === undefined) return null;

    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) return null;
    const segment = buffer.subarray(offset, end);
    const data = segment.subarray(4);

    if (marker === APP1 && data.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
      const orientation = exifOrientation(data.subarray(6));
      if (orientation > 1) parts.push(orientationOnlyExif(orientation));
    } else if (marker === APP0 || marker === APP14 || (marker === APP2 && data.subarray(0, 12).toString('latin1') === 'ICC_PROFILE\0')) {
      parts.push(segment);
    } else if (!(marker >= APP0 && marker <= 0xef) && marker !== COM) {
      parts.push(segment);
    }
    offset = end;
  }

  return null; // no image data
}

/** The Orientation tag (0x0112) of IFD0, or 1 (upright) if there is none. */
function exifOrientation(tiff: Buffer): number {
  const bigEndian = tiff.toString('latin1', 0, 2) === 'MM';
  const u16 = (at: number) => (bigEndian ? tiff.readUInt16BE(at) : tiff.readUInt16LE(at));
  const u32 = (at: number) => (bigEndian ? tiff.readUInt32BE(at) : tiff.readUInt32LE(at));
  const ifd = u32(4);
  for (let i = 0; i < u16(ifd); i += 1) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function orientationOnlyExif(orientation: number): Buffer {
  const segment = Buffer.alloc(36);
  segment.writeUInt16BE(0xff00 | APP1, 0);
  segment.writeUInt16BE(34, 2);
  segment.write('Exif\0\0MM\0*', 4, 'latin1');
  segment.writeUInt32BE(8, 14); // IFD0 right after the TIFF header
  segment.writeUInt16BE(1, 18); // one entry
  segment.writeUInt16BE(0x0112, 20); // Orientation, SHORT, count 1
  segment.writeUInt16BE(3, 22);
  segment.writeUInt32BE(1, 24);
  segment.writeUInt16BE(orientation, 28);
  // Bytes 32-35 stay 0: no next IFD.
  return segment;
}

const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** Drops EXIF, text and timestamp chunks, and anything after IEND. */
function stripPng(buffer: Buffer): Buffer | null {
  const parts: Buffer[] = [buffer.subarray(0, 8)];
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length || (offset === 8 && type !== 'IHDR')) return null;
    if (!PNG_METADATA.has(type)) parts.push(buffer.subarray(offset, end));
    if (type === 'IEND') return Buffer.concat(parts);
    offset = end;
  }

  return null; // no IEND
}

/** Drops the EXIF and XMP chunks, clears their flags in VP8X, and fixes the RIFF size. */
function stripWebp(buffer: Buffer): Buffer | null {
  const riffEnd = 8 + buffer.readUInt32LE(4);
  if (riffEnd > buffer.length) return null;
  const chunks: Buffer[] = [];
  let offset = 12;

  while (offset + 8 <= riffEnd) {
    const fourCC = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2); // chunks are padded to an even size
    if (end > riffEnd) return null;
    if (fourCC === 'VP8X') {
      const chunk = Buffer.from(buffer.subarray(offset, end));
      chunk[8] &= ~(0x08 | 0x04); // EXIF and XMP present flags
      chunks.push(chunk);
    } else if (fourCC !== 'EXIF' && fourCC !== 'XMP ') {
      chunks.push(buffer.subarray(offset, end));
    }
    offset = end;
  }
  if (chunks.length === 0) return null;

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
