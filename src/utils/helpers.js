// src/utils/helpers.js
// ============================================================
// Utility Helper Functions
// ============================================================

const crypto = require('crypto');

// ── Generate 6-character Share Code ─────────────────────────

const generateShareCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars: I, O, 0, 1
  let code = '';
  const randomBytes = crypto.randomBytes(6);
  
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  
  return code;
};

// ── Validate Email Format ───────────────────────────────────

const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// ── Validate Password Strength ──────────────────────────────

const validatePassword = (password) => {
  const errors = [];
  
  if (password.length < 8) {
    errors.push('Password must be at least 8 characters');
  }
  
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    strength: calculatePasswordStrength(password),
  };
};

const calculatePasswordStrength = (password) => {
  let strength = 0;
  
  if (password.length >= 8) strength++;
  if (password.length >= 12) strength++;
  if (/[A-Z]/.test(password)) strength++;
  if (/[a-z]/.test(password)) strength++;
  if (/[0-9]/.test(password)) strength++;
  if (/[^A-Za-z0-9]/.test(password)) strength++;
  
  if (strength <= 2) return 'weak';
  if (strength <= 4) return 'medium';
  return 'strong';
};

// ── Sanitize String ─────────────────────────────────────────

const sanitizeString = (str) => {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>]/g, '');
};

// ── Parse Price String ──────────────────────────────────────

const parsePrice = (priceStr) => {
  if (typeof priceStr === 'number') return priceStr;
  if (!priceStr) return 0;
  
  const cleaned = String(priceStr).replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  
  return isNaN(parsed) ? 0 : Math.round(parsed * 100) / 100;
};

// ── Format Currency ─────────────────────────────────────────

const formatCurrency = (amount, currency = 'USD') => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(amount);
};

// ── Calculate Distance (Haversine) ──────────────────────────

const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return Math.round(distance * 100) / 100; // km with 2 decimal places
};

const toRad = (deg) => deg * (Math.PI / 180);

// ── Department Detection ────────────────────────────────────

const DEPARTMENT_KEYWORDS = {
  'Produce': ['apple', 'banana', 'orange', 'lettuce', 'tomato', 'potato', 'onion', 'carrot', 'broccoli', 'spinach', 'fruit', 'vegetable', 'salad', 'herbs'],
  'Dairy': ['milk', 'cheese', 'yogurt', 'butter', 'cream', 'egg', 'cottage', 'sour cream'],
  'Meat': ['chicken', 'beef', 'pork', 'turkey', 'steak', 'ground', 'bacon', 'sausage', 'ham'],
  'Seafood': ['fish', 'salmon', 'shrimp', 'tuna', 'crab', 'lobster', 'tilapia'],
  'Bakery': ['bread', 'bagel', 'muffin', 'croissant', 'donut', 'cake', 'cookie', 'pastry', 'bun', 'roll'],
  'Frozen': ['frozen', 'ice cream', 'pizza', 'popsicle'],
  'Beverages': ['water', 'juice', 'soda', 'coffee', 'tea', 'drink', 'cola', 'beer', 'wine'],
  'Snacks': ['chips', 'crackers', 'popcorn', 'nuts', 'pretzels', 'candy'],
  'Canned Goods': ['canned', 'beans', 'soup', 'tomato sauce', 'corn'],
  'Condiments': ['ketchup', 'mustard', 'mayo', 'sauce', 'dressing', 'oil', 'vinegar'],
  'Cereal': ['cereal', 'oatmeal', 'granola'],
  'Pasta': ['pasta', 'spaghetti', 'noodle', 'macaroni', 'rice'],
  'Household': ['paper towel', 'toilet paper', 'detergent', 'soap', 'cleaner'],
  'Personal Care': ['shampoo', 'toothpaste', 'deodorant', 'lotion', 'razor'],
};

const detectDepartment = (itemName) => {
  const lowerName = itemName.toLowerCase();
  
  for (const [department, keywords] of Object.entries(DEPARTMENT_KEYWORDS)) {
    if (keywords.some(keyword => lowerName.includes(keyword))) {
      return department;
    }
  }
  
  return 'Other';
};

// ── Pagination Helper ───────────────────────────────────────

const paginate = (query, page = 1, limit = 20) => {
  const offset = (page - 1) * limit;
  return {
    limit: Math.min(limit, 100), // Max 100 items per page
    offset,
    page: parseInt(page),
  };
};

// ── Date Helpers ────────────────────────────────────────────

const formatDate = (date) => {
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const isExpired = (date) => {
  return new Date(date) < new Date();
};

const addDays = (date, days) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

module.exports = {
  generateShareCode,
  isValidEmail,
  validatePassword,
  sanitizeString,
  parsePrice,
  formatCurrency,
  calculateDistance,
  detectDepartment,
  paginate,
  formatDate,
  isExpired,
  addDays,
};
