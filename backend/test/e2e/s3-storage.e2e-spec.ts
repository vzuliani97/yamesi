import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config';
import { S3FileStorage } from '../../src/storage/storage.module';

// Runs against a real S3-compatible server (RustFS in docker-compose). Skipped when none is configured.
const endpoint = process.env.S3_TEST_ENDPOINT;
const describeS3 = endpoint ? describe : describe.skip;

describeS3('S3 file storage (real object store)', () => {
  let storage: S3FileStorage;

  beforeAll(async () => {
    storage = new S3FileStorage(
      loadConfig({
        ...process.env,
        S3_ENDPOINT: endpoint,
        S3_PUBLIC_ENDPOINT: endpoint,
        S3_BUCKET: `yamesi-test-${Date.now()}`,
        S3_ACCESS_KEY: process.env.S3_TEST_ACCESS_KEY,
        S3_SECRET_KEY: process.env.S3_TEST_SECRET_KEY,
      }),
    );
    await storage.onModuleInit(); // creates the bucket
  });

  it('stores and reads back a binary object', async () => {
    const key = `tests/${randomUUID()}.bin`;
    const body = Buffer.from([0, 1, 2, 250, 251, 252]);

    await storage.put(key, body, 'application/octet-stream');

    expect(await storage.get(key)).toEqual(body);
  });

  it('issues a presigned URL that works without credentials and expires', async () => {
    const key = `tests/${randomUUID()}.txt`;
    await storage.put(key, Buffer.from('factura'), 'text/plain');

    const url = await storage.signedUrl(key, 60);
    const response = await fetch(url);

    expect(url).toContain('X-Amz-Signature=');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('factura');

    // Same length, one character changed: a well-formed but forged signature.
    const tampered = url.replace(/(X-Amz-Signature=[0-9a-f]*)([0-9a-f])/, (_m, head: string, last: string) =>
      head + (last === '0' ? '1' : '0'),
    );
    expect((await fetch(tampered)).status).toBe(403);
  });
});
