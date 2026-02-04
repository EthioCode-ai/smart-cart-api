require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import routes
const storesRoutes = require('./routes/stores');
const layoutsRoutes = require('./routes/layouts');
const contributionsRoutes = require('./routes/contributions');
const rewardsRoutes = require('./routes/rewards');
const authRoutes = require('./routes/auth');
const videoProcessingRoutes = require('./routes/videoProcessing');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Smart Cart API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/stores', storesRoutes);
app.use('/api/layouts', layoutsRoutes);
app.use('/api/contributions', contributionsRoutes);
app.use('/api/rewards', rewardsRoutes);
app.use('/api/video-processing', videoProcessingRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Smart Cart API running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
