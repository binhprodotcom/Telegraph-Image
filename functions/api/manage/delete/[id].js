import { jsonResponse } from '../../../utils/http.js';
import { deleteManagedRecord } from '../../../utils/delete-record.js';

// Backward-compatible path endpoint. The dashboard now uses POST /delete with
// a JSON body so special characters never have to travel inside a route segment.
export async function onRequest(context) {
  const result = await deleteManagedRecord(context.env, context.params.id);
  return jsonResponse(result);
}
