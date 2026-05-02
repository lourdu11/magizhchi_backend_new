require('dotenv').config();
const express = require('express');
const path = require('path');

// ─── Environment Validation (Fail-Fast) ────────────────────────
const requiredEnvs = ['MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'FRONTEND_URL'];
const placeholders = ['CHANGE_IN_PROD', 'your_gmail', 'placeholder'];

requiredEnvs.forEach(env => {
  if (!process.env[env] || placeholders.some(p => process.env[env].includes(p))) {
    console.error(`\n❌ CRITICAL ERROR: Environment variable "${env}" is missing or contains a placeholder.`);
    console.error(`👉 Please update your .env file or cloud environment variables before starting in production.\n`);
    process.exit(1);
  }
});
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const compression = require('compression');
// Lightweight NoSQL injection sanitizer (replaces express-mongo-sanitize)
const mongoSanitize = (req, res, next) => {
  const sanitize = (obj) => {
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(k => {
        if (k.startsWith('$') || k.includes('.')) delete obj[k];
        else sanitize(obj[k]);
      });
    }
  };
  sanitize(req.body);
  sanitize(req.params);
  next();
};

const errorHandler = require('./src/middlewares/errorHandler');
const { defaultLimiter } = require('./src/middlewares/rateLimiter');
const logger = require('./src/utils/logger');

// Route imports
const authRoutes = require('./src/routes/auth.routes');
const productRoutes = require('./src/routes/product.routes');
const categoryRoutes = require('./src/routes/category.routes');
const cartRoutes = require('./src/routes/cart.routes');
const wishlistRoutes = require('./src/routes/wishlist.routes');
const orderRoutes = require('./src/routes/order.routes');
const billRoutes = require('./src/routes/bill.routes');
const adminRoutes = require('./src/routes/admin.routes');
const couponRoutes = require('./src/routes/coupon.routes');
const reviewRoutes = require('./src/routes/review.routes');
const bannerRoutes = require('./src/routes/banner.routes');
const userRoutes = require('./src/routes/user.routes');
const publicRoutes = require('./src/routes/public.routes');
const publicController = require('./src/controllers/public.controller');
const upload = require('./src/middlewares/upload.middleware');
const { protect, isAdmin } = require('./src/middlewares/auth');
// settingsRoutes removed as it is now part of adminRoutes




const app = express();
app.set('trust proxy', 1); // Trust Render proxy for rate limiting

// ⚠️ FORCE 200 OK FOR ALL OPTIONS PREFLIGHT REQUESTS ⚠️
// This must be at the very top to prevent 204 No Content confusion.
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-rtb-fingerprint-id, request-id');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '0'); // Do not cache preflight during testing
    return res.status(200).send();
  }
  next();
});


// ─── Security Middleware ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "frame-src": ["'self'", "https://*.razorpay.com", "https://razorpay.com", "https://*.google.com", "https://www.google.com"],
      "frame-ancestors": ["'self'", "https://*.razorpay.com", "https://razorpay.com"],
      "script-src": ["'self'", "'unsafe-inline'", "https://checkout.razorpay.com", "https://*.razorpay.com", "https://*.google.com", "https://www.google.com", "https://*.gstatic.com"],
      "img-src": ["'self'", "data:", "https://*.razorpay.com", "https://ik.imagekit.io", "https://res.cloudinary.com", "https://*.google.com"],
      "connect-src": ["'self'", "https://*.razorpay.com", "https://magizhchi-backend-new-1.onrender.com", "https://magizhchi-backend-new.onrender.com", "https://ik.imagekit.io", "https://res.cloudinary.com"],
    },
  },
}));
app.use(cors({
  origin: [
    'https://magizhchigarments.vercel.app',
    /^https:\/\/magizhchigarments-.*\.vercel\.app$/,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-rtb-fingerprint-id', 'request-id'],
  exposedHeaders: ['x-rtb-fingerprint-id', 'request-id'],
  optionsSuccessStatus: 200
}));

app.use(mongoSanitize); // Prevent NoSQL injection

// ─── Body Parsing ─────────────────────────────────────────────
// Raw body for Razorpay webhook signature verification
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(compression());
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  maxAge: '30d', // 1 month caching
  etag: true,
  lastModified: true
}));

// ─── Logging ──────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

// ─── Global Rate Limiter ──────────────────────────────────────
app.use('/api', defaultLimiter);

// ─── Health Check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.set('X-Server-Location', process.env.RENDER ? 'Render-Cloud' : 'Local-Machine');
  res.json({ success: true, message: 'Welcome to Magizhchi API' });
});

app.use((req, res, next) => {
  res.set('X-Server-Location', process.env.RENDER ? 'Render-Cloud' : 'Local-Machine');
  next();
});

app.get('/api/v1/health', (req, res) => {
  const { isReady, getQRLink } = require('./src/services/whatsapp.service');
  const ready = isReady();
  res.json({ 
    success: true, 
    message: 'Magizhchi API is running', 
    whatsapp: ready ? 'Ready' : 'Not Connected',
    qrLink: !ready ? getQRLink() : null,
    timestamp: new Date().toISOString() 
  });
});

// ─── API Routes ───────────────────────────────────────────────
const API = '/api/v1';

// VIP Priority Routes (Procurement & Scanning)
app.use(`${API}/admin/inventory`, protect, isAdmin, require('./src/routes/inventory.routes'));
app.use(`${API}/admin`, adminRoutes);

app.use(`${API}/public`, publicRoutes);
app.post(`${API}/contact`, publicController.submitContactForm); 
app.use(`${API}/auth`, authRoutes);
app.use(`${API}/products`, productRoutes);
app.use(`${API}/categories`, categoryRoutes);
app.use(`${API}/cart`, cartRoutes);
app.use(`${API}/wishlist`, wishlistRoutes);
app.use(`${API}/orders`, orderRoutes);
app.use(`${API}/payments`, require('./src/routes/payment.routes'));
app.use(`${API}/bills`, billRoutes);
app.use(`${API}/coupons`, couponRoutes);
app.use(`${API}/reviews`, reviewRoutes);
app.use(`${API}/banners`, bannerRoutes);
app.use(`${API}/users`, userRoutes);

// Debug route to verify route health
app.get(`${API}/health/procurement`, (req, res) => res.json({ status: 'active', routes: ['admin/purchases', 'admin/suppliers'] }));

// ─── Utility Routes ───────────────────────────────────────────
app.post(`${API}/upload`, protect, isAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  res.json({ success: true, url: req.file.path });
});
// settings handled in admin routes




// ─── 404 Handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────
app.use(errorHandler);

// ─── Global Crash Logging ──────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error(`🔥 UNCAUGHT EXCEPTION: ${err.message}`);
  logger.error(err.stack);
  // Give logger time to write before exiting
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`🔥 UNHANDLED REJECTION: ${reason}`);
  if (reason.stack) logger.error(reason.stack);
});

// Final trigger for route migration
module.exports = app;
