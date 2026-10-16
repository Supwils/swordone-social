/**
 * Upload edge cases of `config/s3.ts`. env is mocked per test (the module reads
 * `s3Enabled` at import), so the result never depends on a developer's
 * server/.env, and the multipart `Upload` is faked so nothing leaves the box.
 * After `vi.resetModules()` class identities split, so errors are matched
 * structurally.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const uploads = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(opts: { params: Record<string, unknown> }) {
      uploads.push(opts.params);
    }
    done() {
      return Promise.resolve({});
    }
  },
}));

async function loadS3(enabled: boolean) {
  vi.resetModules();
  vi.doMock('./env', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./env')>();
    return {
      ...actual,
      env: {
        ...actual.env,
        AWS_REGION: 'us-east-2',
        AWS_ACCESS_KEY_ID: 'test-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
        AWS_S3_BUCKET: 'test-bucket',
        AWS_CLOUDFRONT_URL: 'https://cdn.example.com',
      },
      s3Enabled: enabled,
    };
  });
  return import('./s3');
}

afterEach(() => {
  uploads.length = 0;
  vi.doUnmock('./env');
});

describe('S3 uploads without a configured bucket', () => {
  // A missing dependency is a 503, not a server fault: a plain `Error` used to
  // reach the errorHandler's 500 branch.
  it('refuses an image upload with 503 UNAVAILABLE', async () => {
    const s3 = await loadS3(false);
    await expect(s3.uploadBufferToS3(Buffer.from('i'), 'avatars')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      status: 503,
    });
  });

  it('refuses a video upload with 503 UNAVAILABLE', async () => {
    const s3 = await loadS3(false);
    await expect(
      s3.uploadVideoBufferToS3(Buffer.from('v'), 'posts', 'video/webm'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
    expect(uploads).toHaveLength(0);
  });
});

describe('video object type', () => {
  it('stores a webm as .webm with Content-Type video/webm', async () => {
    const s3 = await loadS3(true);
    const out = await s3.uploadVideoBufferToS3(Buffer.from('v'), 'posts', 'video/webm');
    expect(uploads[0]).toMatchObject({ ContentType: 'video/webm' });
    expect(String(uploads[0].Key)).toMatch(/^posts\/.+\.webm$/);
    expect(out.url).toMatch(/^https:\/\/cdn\.example\.com\/posts\/.+\.webm$/);
  });

  it('stores an mp4 (and the no-mimetype default) as .mp4 / video/mp4', async () => {
    const s3 = await loadS3(true);
    await s3.uploadVideoBufferToS3(Buffer.from('v'), 'posts', 'video/mp4');
    await s3.uploadVideoBufferToS3(Buffer.from('v'), 'posts');
    for (const params of uploads) {
      expect(params).toMatchObject({ ContentType: 'video/mp4' });
      expect(String(params.Key)).toMatch(/\.mp4$/);
    }
    expect(uploads).toHaveLength(2);
  });
});
