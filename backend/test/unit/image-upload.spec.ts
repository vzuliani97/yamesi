import { detectImageType } from '../../src/common/image-upload';

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
