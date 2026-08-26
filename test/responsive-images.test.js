const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

function createMockR2(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, {
    body: value.body || value,
    contentType: value.contentType || 'image/webp',
  }]));
  const operations = { get: [], head: [], put: [], delete: [] };

  function objectFor(key, includeBody) {
    const entry = store.get(key);
    if (!entry) return null;
    return {
      body: includeBody ? entry.body : null,
      etag: `etag-${key}`,
      version: `version-${key}`,
      httpEtag: `"etag-${key}"`,
      writeHttpMetadata(headers) {
        headers.set('Content-Type', entry.contentType);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      },
    };
  }

  return {
    operations,
    async get(key) {
      operations.get.push(key);
      return objectFor(key, true);
    },
    async head(key) {
      operations.head.push(key);
      return objectFor(key, false);
    },
    async put(key, bytes, options = {}) {
      operations.put.push({ key, options });
      store.set(key, {
        body: new Uint8Array(bytes),
        contentType: options.httpMetadata?.contentType || 'application/octet-stream',
      });
      return objectFor(key, false);
    },
    async delete(key) {
      operations.delete.push(key);
      store.delete(key);
    },
  };
}

describe('responsive R2 images', function () {
  let restoreConsole;

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  it('serves an exact responsive variant and falls back to the original', async function () {
    const { onRequest } = await import('../functions/file/[id].js');
    const originalKey = 'uploads/2026/08/photo.jpg';
    const variantKey = 'uploads/2026/08/photo.w960.webp';
    const IMAGE_BUCKET = createMockR2({
      [originalKey]: { body: 'original', contentType: 'image/jpeg' },
      [variantKey]: { body: 'variant-960', contentType: 'image/webp' },
    });
    const metadata = {
      TimeStamp: Date.now(),
      ListType: 'None',
      Label: 'None',
      fileName: 'photo.jpg',
      r2Key: originalKey,
      responsiveVariants: {
        960: { r2Key: variantKey, width: 960, height: 600, contentType: 'image/webp' },
      },
    };
    const img_url = createMockKV({ 'r2_photo.jpg': metadata });

    const variantResponse = await onRequest(makeContext({
      request: new Request('https://example.com/file/r2_photo.jpg?w=960'),
      env: { img_url, IMAGE_BUCKET },
      params: { id: 'r2_photo.jpg' },
    }));
    assert.strictEqual(await variantResponse.text(), 'variant-960');
    assert.strictEqual(variantResponse.headers.get('Content-Type'), 'image/webp');
    assert.strictEqual(variantResponse.headers.get('X-BBC-Responsive-Width'), '960');

    const fallbackResponse = await onRequest(makeContext({
      request: new Request('https://example.com/file/r2_photo.jpg?w=1600'),
      env: { img_url, IMAGE_BUCKET },
      params: { id: 'r2_photo.jpg' },
    }));
    assert.strictEqual(await fallbackResponse.text(), 'original');
    assert.strictEqual(fallbackResponse.headers.get('X-BBC-Responsive-Width'), 'original');
    assert.deepStrictEqual(IMAGE_BUCKET.operations.get, [variantKey, originalKey]);
  });

  it('uploads only smaller variants and stores their R2 metadata', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const IMAGE_BUCKET = createMockR2();
    const img_url = createMockKV({}, { metadataLimitBytes: 1024 });
    const formData = new FormData();
    formData.append('file', new File(['original'], 'poster.png', { type: 'image/png' }));
    formData.append('albumId', 'unclassified');
    formData.append('capturedAt', '1787700000000');
    formData.append('imageWidth', '1200');
    formData.append('imageHeight', '800');
    formData.append('variant_480', new File(['small-480'], 'poster-w480.webp', { type: 'image/webp' }));
    formData.append('variantHeight_480', '320');
    formData.append('variant_960', new File(['small-960'], 'poster-w960.webp', { type: 'image/webp' }));
    formData.append('variantHeight_960', '640');

    const response = await onRequestPost(makeContext({
      request: new Request('https://example.com/upload', { method: 'POST', body: formData }),
      env: {
        disable_telemetry: 'true',
        STORAGE_MODE: 'r2',
        IMAGE_BUCKET,
        img_url,
      },
    }));

    assert.strictEqual(response.status, 200);
    const [result] = JSON.parse(await response.text());
    assert.deepStrictEqual(result.responsiveWidths, [480, 960]);
    assert.strictEqual(IMAGE_BUCKET.operations.put.length, 3);
    assert.ok(IMAGE_BUCKET.operations.put[1].key.endsWith('.w480.webp'));
    assert.ok(IMAGE_BUCKET.operations.put[2].key.endsWith('.w960.webp'));
    assert.strictEqual(IMAGE_BUCKET.operations.put.some(operation => operation.key.endsWith('.w1600.webp')), false);

    const publicId = result.src.split('/').pop();
    const stored = img_url.snapshot(publicId);
    const metadata = stored.metadata;
    const fullMetadata = JSON.parse(stored.value);
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    assert.ok(metadataBytes <= 1024, `KV metadata must be <= 1024 bytes, got ${metadataBytes}`);
    assert.strictEqual(metadata.imageWidth, 1200);
    assert.strictEqual(metadata.imageHeight, 800);
    assert.deepStrictEqual(Object.keys(metadata.responsiveVariants), ['480', '960']);
    assert.strictEqual(fullMetadata.responsiveVariants['480'].height, 320);
    assert.ok(fullMetadata.responsiveVariants['480'].etag);
  });

  it('deletes the original and every generated variant', async function () {
    const { deleteR2Object } = await import('../functions/utils/storage.js');
    const IMAGE_BUCKET = createMockR2();
    const metadata = {
      r2Key: 'uploads/original.jpg',
      responsiveVariants: {
        480: { r2Key: 'uploads/original.w480.webp' },
        960: { r2Key: 'uploads/original.w960.webp' },
      },
    };

    await deleteR2Object({ IMAGE_BUCKET }, metadata);
    assert.deepStrictEqual(IMAGE_BUCKET.operations.delete, [
      'uploads/original.jpg',
      'uploads/original.w480.webp',
      'uploads/original.w960.webp',
    ]);
  });

  it('keeps three responsive variants below the Workers KV metadata limit', async function () {
    const {
      createDefaultMetadata,
      createKvFileMetadata,
      kvMetadataSize,
    } = await import('../functions/utils/metadata.js');
    const root = 'uploads/2026/08/12345678-1234-4234-8234-123456789abc.jpg';
    const verboseVariant = width => ({
      r2Key: root.replace('.jpg', `.w${width}.webp`),
      width,
      height: Math.round(width * 0.67),
      fileSize: 180000,
      etag: 'etag-value-that-does-not-belong-in-kv-list-metadata',
      version: 'version-value-that-does-not-belong-in-kv-list-metadata',
      contentType: 'image/webp',
    });
    const full = createDefaultMetadata('r2_photo.jpg', {
      fileName: 'Vina-Vit-Lon-Display-Typeface-mien-phi.jpg',
      clientAssetId: `v1|${'x'.repeat(300)}`,
      contentHash: 'f'.repeat(64),
      r2Key: root,
      responsiveVariants: {
        480: verboseVariant(480),
        960: verboseVariant(960),
        1600: verboseVariant(1600),
      },
    });

    const compact = createKvFileMetadata(full, 'r2_photo.jpg');
    assert.ok(kvMetadataSize(compact) <= 1024);
    assert.deepStrictEqual(Object.keys(compact.responsiveVariants), ['480', '960', '1600']);
    assert.deepStrictEqual(Object.keys(compact.responsiveVariants['1600']), ['r2Key']);
  });

  it('rejects an uploaded variant that would upscale a small source', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const IMAGE_BUCKET = createMockR2();
    const img_url = createMockKV();
    const formData = new FormData();
    formData.append('file', new File(['small-original'], 'small.png', { type: 'image/png' }));
    formData.append('imageWidth', '700');
    formData.append('imageHeight', '350');
    formData.append('variant_960', new File(['invalid-upscale'], 'small-w960.webp', { type: 'image/webp' }));
    formData.append('variantHeight_960', '480');

    const response = await onRequestPost(makeContext({
      request: new Request('https://example.com/upload', { method: 'POST', body: formData }),
      env: {
        disable_telemetry: 'true',
        STORAGE_MODE: 'r2',
        IMAGE_BUCKET,
        img_url,
      },
    }));

    assert.strictEqual(response.status, 400);
    assert.match((await response.json()).error, /Không được phóng ảnh gốc/);
    assert.strictEqual(IMAGE_BUCKET.operations.put.length, 0);
  });

  it('builds stable R2 keys only for supported widths', async function () {
    const { createR2VariantKey, normalizeResponsiveWidth } = await import('../functions/utils/storage.js');
    assert.strictEqual(
      createR2VariantKey('uploads/2026/08/photo.original.jpg', 480),
      'uploads/2026/08/photo.original.w480.webp',
    );
    assert.strictEqual(normalizeResponsiveWidth('960'), 960);
    assert.strictEqual(normalizeResponsiveWidth('700'), 0);
    assert.throws(() => createR2VariantKey('uploads/photo.jpg', 700));
  });
});
