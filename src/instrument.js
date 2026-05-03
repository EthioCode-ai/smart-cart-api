// src/instrument.js
// ============================================================
// Sentry initialization — MUST be required before any other module
// in server.js so OpenTelemetry auto-instrumentation can hook the
// other libraries (express, http, pg, etc.) at load time.
//
// Avi's directive (2026-05-03):
//   - Sample rate 100% at launch (revisit when volume warrants)
//   - PII scrubbing ON: no emails, locations, scan contents,
//     cookies, query strings, request bodies auto-captured
//   - DSN from env (Render env var SENTRY_DSN, never committed)
//   - No-op gracefully if DSN is missing (so dev/staging without
//     Sentry config keeps working)
// ============================================================

const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.RENDER_GIT_COMMIT || 'unknown',

    // 100% capture at launch — moat regressions on /ocr-vision and
    // /batch-price must be visible from event #1.
    tracesSampleRate: 1.0,

    // Strict PII off — no auto-capturing identifying user data.
    sendDefaultPii: false,

    beforeSend(event, hint) {
      // Defense-in-depth scrubbing on top of sendDefaultPii: false.
      if (event.user) {
        delete event.user.email;
        delete event.user.ip_address;
        delete event.user.geo;
      }
      if (event.request) {
        // Request body could carry scan data, GPS coords, OCR text,
        // image base64, prices. None of that should leave the wire
        // unredacted - even the body shape is sensitive.
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
          delete event.request.headers['x-forwarded-for'];
        }
      }
      // Strip device-identifying breadcrumbs.
      if (event.contexts && event.contexts.os) {
        delete event.contexts.os.id;
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      // HTTP request breadcrumbs include URLs that may contain
      // barcodes, store IDs, or other tokens. Keep the shape but
      // drop query strings/bodies.
      if (breadcrumb.category === 'http' && breadcrumb.data) {
        delete breadcrumb.data.body;
        delete breadcrumb.data.query;
      }
      return breadcrumb;
    },
  });
  console.log('[Sentry] Initialized');
} else {
  console.log('[Sentry] No DSN configured - errors will not be reported');
}
