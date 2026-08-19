import { jsonResponse } from '../../utils/http.js';
import { deleteManagedRecord } from '../../utils/delete-record.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return jsonResponse({ error: 'JSON không hợp lệ.' }, { status: 400 });
  }

  const id = typeof payload?.id === 'string' ? payload.id : '';
  if (!id) {
    return jsonResponse({ error: 'Thiếu ID bản ghi cần xóa.' }, { status: 400 });
  }

  const result = await deleteManagedRecord(context.env, id);
  return jsonResponse(result);
}
