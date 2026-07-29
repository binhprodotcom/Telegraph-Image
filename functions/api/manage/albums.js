import { jsonResponse } from '../../utils/http.js';
import {
  createAlbum,
  deleteAlbumBatch,
  ensureDefaultAlbums,
  listAlbums,
  renameAlbum,
} from '../../utils/albums.js';

export async function onRequestGet({ env }) {
  try {
    await ensureDefaultAlbums(env);
    return jsonResponse({
      albums: await listAlbums(env),
      virtualAlbums: [{ id: 'unclassified', name: 'Chưa phân loại', virtual: true }],
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await readJson(request);
    return jsonResponse({ album: await createAlbum(env, body.name) }, { status: 201 });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function onRequestPut({ request, env }) {
  try {
    const body = await readJson(request);
    return jsonResponse({
      album: await renameAlbum(env, body.id, body.name, {
        name: body.currentName,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
      }),
    });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return jsonResponse({ error: 'Thiếu album id.' }, { status: 400 });
    return jsonResponse(await deleteAlbumBatch(env, id));
  } catch (error) {
    return errorResponse(error, 400);
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Dữ liệu JSON không hợp lệ.');
  }
}

function errorResponse(error, fallbackStatus = 500) {
  const message = error instanceof Error && error.message
    ? error.message
    : 'Có lỗi xảy ra khi xử lý album.';

  const status = /không tìm thấy/i.test(message)
    ? 404
    : /đã tồn tại|đã có album|không được|để trống|thiếu/i.test(message)
      ? 400
      : fallbackStatus;

  return jsonResponse(
    { error: message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
