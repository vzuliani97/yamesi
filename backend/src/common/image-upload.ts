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

export function requireImage(file: Express.Multer.File): ImageType {
  const type = detectImageType(file.buffer);

  if (!type) {
    throw new AppError(400, 'INVALID_IMAGE', 'Only JPEG, PNG or WebP images are accepted');
  }

  return type;
}
