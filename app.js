require('dotenv').config();
const express = require('express');
const path = require('path');
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");

// ─── Sentry Initialization ─────────────────────────────────────
Sentry.init({
  dsn: process.env.SENTRY_DSN || "https://placeholder@sentry.io/placeholder",
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

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
const hpp = require('hpp');
const app = express();
app.set('trust proxy', 1);

// ─── Middleware ────────────────────────────────────────────────
app.use(compression()); // Enable Gzip/Brotli compression

// CORS configured once below after helmet — DO NOT add a second cors() call

const errorHandler = require('./src/middlewares/errorHandler');
const { defaultLimiter, contactLimiter, uploadLimiter } = require('./src/middlewares/rateLimiter');
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
const { upload, validateMimeType, uploadToCloudinary } = require('./src/middlewares/upload.middleware');
const { protect, isAdmin, isStaff } = require('./src/middlewares/auth');

// ─── Security Middleware ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "frame-src": ["'self'", "https://*.razorpay.com", "https://razorpay.com", "https://*.google.com", "https://www.google.com"],
      "frame-ancestors": ["'self'", "https://*.razorpay.com", "https://razorpay.com"],
      "script-src": ["'self'", "https://checkout.razorpay.com", "https://*.razorpay.com", "https://*.google.com", "https://www.google.com", "https://*.gstatic.com"],
      "img-src": ["'self'", "data:", "https://*.razorpay.com", "https://ik.imagekit.io", "https://res.cloudinary.com", "https://*.google.com", "https://images.unsplash.com", "https://placehold.co"],
      "connect-src": ["'self'", "https://*.razorpay.com", "https://magizhchi-backend-28sx.onrender.com", "https://ik.imagekit.io", "https://res.cloudinary.com"],
    },
  },
}));
const allowedOrigins = [...new Set([
  process.env.FRONTEND_URL,
  ...(process.env.ALLOWED_ORIGINS?.split(',') || []),
  process.env.NODE_ENV !== 'production' ? 'http://localhost:5173' : null
].filter(Boolean).map(origin => origin.trim()))];

// BUG #16 FIX: Single merged cors() config — supports all configured frontend origins
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  optionsSuccessStatus: 200
}));

// ─── Body Parsing ─────────────────────────────────────────────
// Raw body for Razorpay webhook signature verification
app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json' }));

// Anti-CSRF Protection Middleware for Mutating API Routes
const csrfProtection = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  
  // Webhooks are signature-verified and public API routes do not use cookie auth.
  if (req.path === '/api/v1/payments/webhook' || req.path.startsWith('/api/v1/public/')) return next();

  // Validate Origin/Referer matches the configured frontend strictly
  const origin = req.headers.origin || req.headers.referer;
  let isValidOrigin = false;
  try {
    if (origin) {
      const originUrl = new URL(origin);
      isValidOrigin = allowedOrigins.some(allowed => {
        try {
          const allowedUrl = new URL(allowed);
          return originUrl.origin === allowedUrl.origin;
        } catch (err) {
          return false;
        }
      });
    }
  } catch (e) {
    isValidOrigin = false;
  }
  
  if (!isValidOrigin) {
    return res.status(403).json({ success: false, message: 'CSRF Token Validation Failed: Invalid or Spoofed Origin' });
  }
  next();
};

app.use(csrfProtection);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(hpp());

// ─── Custom NoSQL Injection Sanitizer (Express 5.x Getter-Safe) ─────
const escapeRegex = (str) => typeof str === 'string' ? str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') : str;

const sanitizeObjectInPlace = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (key.startsWith('$') || key.includes('.')) {
        delete obj[key];
      } else {
        sanitizeObjectInPlace(obj[key]);
      }
    }
  }
  return obj;
};

const customMongoSanitize = (req, res, next) => {
  if (req.body) sanitizeObjectInPlace(req.body);
  if (req.query) {
    sanitizeObjectInPlace(req.query);
    if (req.query.search) req.query.search = escapeRegex(req.query.search);
    if (req.query.q) req.query.q = escapeRegex(req.query.q);
    if (req.query.k) req.query.k = escapeRegex(req.query.k);
    if (req.query.category && typeof req.query.category === 'string' && !/^[0-9a-fA-F]{24}$/.test(req.query.category)) {
      req.query.category = escapeRegex(req.query.category);
    }
  }
  if (req.params) sanitizeObjectInPlace(req.params);
  next();
};

app.use(customMongoSanitize);
// Removed stateful local `/uploads` serving (Files are on Cloudinary)

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
  const { isReady } = require('./src/services/whatsapp.service');
  const ready = isReady();
  res.json({ 
    success: true, 
    message: 'Magizhchi API is running', 
    whatsapp: ready ? 'Ready' : 'Not Connected',
    timestamp: new Date().toISOString() 
  });
});

// ─── API Routes ───────────────────────────────────────────────
const API = '/api/v1';


// VIP Priority Routes (Procurement & Scanning)
app.use(`${API}/admin/inventory`, protect, isStaff, require('./src/routes/inventory.routes'));

app.use(`${API}/admin`, adminRoutes);

app.use(`${API}/public`, publicRoutes);
app.post(`${API}/contact`, contactLimiter, publicController.submitContactForm);
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

// ─── Utility Routes ───────────────────────────────────────────
app.post(`${API}/upload`, protect, isAdmin, uploadLimiter, upload.single('image'), validateMimeType, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  try {
    const result = await uploadToCloudinary(req.file.buffer, 'magizhchi/products');
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});
// settings handled in admin routes
// ─── 404 Handler ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Sentry Error Handler ──────────────────────────────────────
Sentry.setupExpressErrorHandler(app);

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
