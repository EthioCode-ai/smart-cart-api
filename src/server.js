// src/server.js
// ============================================================
// SMART CART API - Server Entry Point
// ============================================================

require('dotenv').config();
require('./instrument'); // Sentry init - MUST be before all other requires
                          // so OTel auto-instrumentation hooks express/http/pg/etc.

const Sentry = require('@sentry/node');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { pool } = require('./models/db');

// Import routes
const authRoutes = require('./routes/auth');
const listsRoutes = require('./routes/lists');
const recipesRoutes = require('./routes/recipes');
const storesRoutes = require('./routes/stores');
const mealPlansRoutes = require('./routes/mealPlans');
const settingsRoutes = require('./routes/settings');
const aiRoutes = require('./routes/ai');
const dashboardRoutes = require('./routes/dashboard');
const storeLayoutRoutes = require('./routes/storeLayouts');
const productsRoutes = require('./routes/products');
const adminRoutes = require('./routes/admin');
const predictionsRoutes = require('./routes/predictions');
const recommendationsRoutes = require('./routes/recommendations');
const scanMetricsRoutes = require('./routes/scanMetrics');
const { startCleanupCron: startDriveTimeCleanup } = require('./services/driveTimeService');
const { startCategorizationWorker } = require('./services/categorizationWorker');
const { startVisionIntelWorker } = require('./services/visionIntelWorker');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many authentication attempts' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ── Routes ──────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api/lists', listsRoutes);
app.use('/api/recipes', recipesRoutes);
app.use('/api/stores', storesRoutes);
app.use('/api/meal-plans', mealPlansRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/store-layouts', storeLayoutRoutes);
app.use('/api/notifications', dashboardRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/predictions', predictionsRoutes);
app.use('/api/recommendations', recommendationsRoutes);
app.use('/api/scan-metrics', scanMetricsRoutes);

// ── Health Check ────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    service: 'Smart Cart API',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// ── 404 Handler ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Sentry Error Handler ────────────────────────────────────
// Must come AFTER all routes/404 and BEFORE the custom global error
// handler. Captures any error passed to next(err) from a route, then
// hands off to the next error middleware (our global handler) so the
// client still gets the JSON response.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Global Error Handler ────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
  });
});

// ── Start Server ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Smart Cart API v2.0               ║
  ║   Running on port ${PORT}              ║
  ║   Environment: ${process.env.NODE_ENV || 'development'}      ║
  ╚══════════════════════════════════════╝
  `);
  // drive_time_cache: deletes rows >30 min old, every 5 min. unref'd so
  // it never blocks shutdown. Lost-on-restart is fine — cache isn't authoritative.
  startDriveTimeCleanup();
  // SCA worker: sweeps products with category='grocery' (default) into the
  // real taxonomy. Idempotent - re-runs on the next interval if anything
  // fails. Backfill of existing rows happens naturally as the worker runs.
  startCategorizationWorker();
  // VEPI worker: vision fingerprints products with image_url that don't
  // have product_intel yet. Same idempotency pattern as SCA. Skips quietly
  // when the column doesn't exist (pre-migration safe).
  startVisionIntelWorker();
});

module.exports = app;
