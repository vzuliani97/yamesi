import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectImageType, requireImage, stripMetadata } from '../../src/common/image-upload';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

describe('image type detection by magic bytes', () => {
  it('recognizes PNG, JPEG and WebP from their content', () => {
    expect(detectImageType(png)?.contentType).toBe('image/png');
    expect(detectImageType(jpeg)?.contentType).toBe('image/jpeg');
    expect(detectImageType(webp)?.contentType).toBe('image/webp');
  });

  it('rejects files that only pretend to be images', () => {
    expect(detectImageType(Buffer.from('<?php system($_GET["c"]); ?>'))).toBeNull();
    expect(detectImageType(Buffer.from('%PDF-1.7 not an image at all'))).toBeNull();
    expect(detectImageType(Buffer.alloc(4))).toBeNull();
  });
});

describe('image metadata stripping', () => {
  const photo = readFileSync(join(__dirname, '../fixtures/piece.jpg'));

  /** Inserts an APP1 EXIF segment, like a phone photo: Orientation and a GPS IFD with latitude 6°N. */
  const withExif = (jpeg: Buffer, orientation?: number) => {
    const tiff = Buffer.alloc(64);
    tiff.write('II*\0', 0, 'latin1'); // little endian this time
    tiff.writeUInt32LE(8, 4);
    const entries = orientation ? 2 : 1;
    tiff.writeUInt16LE(entries, 8);
    let entry = 10;
    if (orientation) {
      tiff.writeUInt16LE(0x0112, entry);
      tiff.writeUInt16LE(3, entry + 2);
      tiff.writeUInt32LE(1, entry + 4);
      tiff.writeUInt16LE(orientation, entry + 8);
      entry += 12;
    }
    tiff.writeUInt16LE(0x8825, entry); // GPSInfo pointer
    tiff.writeUInt16LE(4, entry + 2);
    tiff.writeUInt32LE(1, entry + 4);
    tiff.writeUInt32LE(40, entry + 8);
    tiff.writeUInt16LE(1, 40); // GPS IFD: GPSLatitudeRef "N"
    tiff.writeUInt16LE(0x0001, 42);
    tiff.writeUInt16LE(2, 44);
    tiff.writeUInt32LE(2, 46);
    tiff.write('N\0', 50, 'latin1');
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const header = Buffer.from([0xff, 0xe1, 0, 0]);
    header.writeUInt16BE(payload.length + 2, 2);
    return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
  };
  const segmentsBeforeScan = (jpeg: Buffer) => {
    const markers: number[] = [];
    for (let offset = 2; jpeg[offset + 1] !== 0xda; offset += 2 + jpeg.readUInt16BE(offset + 2)) {
      markers.push(jpeg[offset + 1]);
    }
    return markers;
  };
  const scanData = (jpeg: Buffer) => jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xda])));
  const upload = (buffer: Buffer) => ({ buffer }) as Express.Multer.File;

  it('removes EXIF with GPS from a JPEG and keeps the image data intact', () => {
    const stripped = requireImage(upload(withExif(photo))).body;

    expect(segmentsBeforeScan(stripped)).not.toContain(0xe1);
    expect(stripped.includes(Buffer.from('Exif'))).toBe(false);
    expect(scanData(stripped).equals(scanData(photo))).toBe(true);
  });

  it('keeps only the orientation, so a photo taken sideways still displays upright', () => {
    const stripped = requireImage(upload(withExif(photo, 6))).body;
    const exif = stripped.subarray(stripped.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6);

    expect(exif.subarray(0, 4).toString('latin1')).toBe('MM\0*');
    expect(exif.readUInt16BE(8)).toBe(1); // a single entry...
    expect(exif.readUInt16BE(10)).toBe(0x0112); // ...the orientation
    expect(exif.readUInt16BE(18)).toBe(6);
  });

  it('drops comments, where a payload could hide', () => {
    const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, 23]), Buffer.from('<script>alert(1)</script>'.slice(0, 21))]);
    const stripped = requireImage(upload(Buffer.concat([photo.subarray(0, 2), comment, photo.subarray(2)]))).body;

    expect(stripped.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('rejects a file that only starts like a JPEG', () => {
    const polyglot = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<html><script>alert(1)</script></html>')]);
    const truncated = photo.subarray(0, 40);

    expect(() => requireImage(upload(polyglot))).toThrow('Only JPEG, PNG or WebP images are accepted');
    expect(stripMetadata(truncated, 'image/jpeg')).toBeNull();
  });

  it('removes text and EXIF chunks from a PNG and anything after its end', () => {
    const chunk = (type: string, data: Buffer) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const iend = png.subarray(png.length - 12);
    const withText = Buffer.concat([
      png.subarray(0, 33), // signature and IHDR
      chunk('tEXt', Buffer.from('Location\0Medellin', 'latin1')),
      chunk('eXIf', Buffer.from('MM\0*', 'latin1')),
      png.subarray(33),
      Buffer.from('<html>after the end</html>'),
    ]);

    const stripped = stripMetadata(withText, 'image/png')!;
    expect(stripped.equals(png)).toBe(true);
    expect(stripped.subarray(stripped.length - 12).equals(iend)).toBe(true);
  });

  it('removes EXIF and XMP chunks from a WebP and clears their flags', () => {
    const chunk = (fourCC: string, data: Buffer) => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(data.length);
      return Buffer.concat([Buffer.from(fourCC, 'latin1'), size, data, Buffer.alloc(data.length % 2)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF, XMP and alpha
    const body = Buffer.concat([
      chunk('VP8X', vp8x),
      chunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])),
      chunk('EXIF', Buffer.from('MM\0* GPS here', 'latin1')),
      chunk('XMP ', Buffer.from('<x:xmpmeta/>', 'latin1')),
    ]);
    const header = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
    header.writeUInt32LE(body.length + 4, 4);

    const stripped = stripMetadata(Buffer.concat([header, body]), 'image/webp')!;
    expect(stripped.includes(Buffer.from('EXIF'))).toBe(false);
    expect(stripped.includes(Buffer.from('XMP '))).toBe(false);
    expect(stripped[20]).toBe(0x10); // only the alpha flag is left
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
  });
});
