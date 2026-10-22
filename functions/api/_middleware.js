import { errorHandling, telemetryData } from '../utils/middleware.js';
// Font-finder tickets/images must never enter legacy remote telemetry.
const privateMedia = context => new URL(context.request.url).pathname.startsWith('/api/font-finder/');
export const onRequest = [
  context => privateMedia(context) ? context.next() : errorHandling(context),
  context => privateMedia(context) ? context.next() : telemetryData(context),
];
