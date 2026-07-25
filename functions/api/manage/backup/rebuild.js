import { isInternalStorageKey } from '../../../utils/albums.js';
import { buildLegacyAssetIndex } from '../../../utils/dedupe.js';
import { jsonResponse } from '../../../utils/http.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => ({}));
  const cursor = body.cursor || undefined;
  const limit = Math.min(100, Math.max(10, Number(body.limit) || 50));

  const page = await env.img_url.list({ limit, cursor });
  let scanned = 0;
  let indexed = 0;
  let skipped = 0;

  for (const key of page.keys) {
    if (isInternalStorageKey(key.name)) continue;
    scanned += 1;

    const record = await env.img_url.getWithMetadata(key.name);
    const metadata = record?.metadata;
    if (!metadata) {
      skipped += 1;
      continue;
    }

    const result = await buildLegacyAssetIndex(env, key.name, metadata);
    if (result.indexed) {
      indexed += 1;
      if (!metadata.clientAssetId) {
        await env.img_url.put(key.name, '', {
          metadata: { ...metadata, clientAssetId: result.clientAssetId },
        });
      }
    } else {
      skipped += 1;
    }
  }

  return jsonResponse({
    scanned,
    indexed,
    skipped,
    complete: page.list_complete,
    cursor: page.list_complete ? null : page.cursor,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
