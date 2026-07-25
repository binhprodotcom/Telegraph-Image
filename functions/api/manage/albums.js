import { jsonResponse } from '../../utils/http.js';
import {
  createAlbum,
  deleteAlbumBatch,
  ensureDefaultAlbums,
  listAlbums,
  renameAlbum,
} from '../../utils/albums.js';

export async function onRequestGet({ env }) {
  await ensureDefaultAlbums(env);
  return jsonResponse({
    albums: await listAlbums(env),
    virtualAlbums: [{ id: 'unclassified', name: 'Chưa phân loại', virtual: true }],
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function onRequestPost({ request, env }) {
  const body = await readJson(request);
  return jsonResponse({ album: await createAlbum(env, body.name) }, { status: 201 });
}

export async function onRequestPut({ request, env }) {
  const body = await readJson(request);
  return jsonResponse({ album: await renameAlbum(env, body.id, body.name) });
}

export async function onRequestDelete({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'Thiếu album id.' }, { status: 400 });
  return jsonResponse(await deleteAlbumBatch(env, id));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Dữ liệu JSON không hợp lệ.');
  }
}
