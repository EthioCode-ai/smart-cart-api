// src/server.js
// ============================================================
// SMART CART API - Server Entry Point
// ============================================================

require('dotenv').config();

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
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/store-layouts', storeLayoutRoutes);
app.use('/api/notifications', dashboardRoutes);

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
});

module.exports = app;
