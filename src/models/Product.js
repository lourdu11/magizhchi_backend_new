const mongoose = require('mongoose');
const slugify = require('slugify');
const leanVirtuals = require('mongoose-lean-virtuals');

const productSchema = new mongoose.Schema(
  {
    // ── SECTION 1: Identity & Product Info ──────────────────
    name: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: false },
    subcategory: { type: String, trim: true },
    brand: { type: String, trim: true, default: 'Magizhchi' },
    sku: { type: String, unique: true, uppercase: true, trim: true },
    barcode: { type: String, trim: true },
    productType: { type: String, trim: true }, // e.g., Finished Good, Raw Material
    productNature: { type: String, enum: ['standalone', 'combo'], default: 'standalone' },
    supplier: { type: String, trim: true },
    procurementSource: { type: String, trim: true }, // e.g., Factory, Vendor, Import
    procurementSourceId: { type: String, trim: true }, // External ID from Procurement Hub

    // ── SECTION 1.5: Combo Configuration ────────────────────
    comboSlots: [{
      id: { type: String },
      name: { type: String },
      products: [{ type: mongoose.Schema.Types.Mixed }], // Stores basic product info for the slot
      allowedSizes: [String],
      allowedColors: [String]
    }],
    comboVariants: [{ type: mongoose.Schema.Types.Mixed }],

    // ── SECTION 2: Pricing & Sales ──────────────────────────
    costPrice: { type: Number, min: 0, default: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    wholesalePrice: { type: Number, min: 0 },
    discountPercentage: { type: Number, default: 0, min: 0, max: 100 },
    discountAmount: { type: Number, default: 0 },
    discountedPrice: { type: Number, default: 0 },
    gstPercentage: { type: Number, default: 12 },
    profitMargin: { type: Number },
    currency: { type: String, default: 'INR' },

    // ── SECTION 3: Inventory & Stock ────────────────────────
    // Aggregated from variants via pre-save
    totalStock: { type: Number, default: 0 },
    availableStock: { type: Number, default: 0 },
    reservedStock: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 10 },
    warehouseLocation: { type: String, trim: true },
    unitType: { type: String, default: 'pcs' },
    stockStatus: { type: String, enum: ['in_stock', 'low_stock', 'out_of_stock'], default: 'in_stock' },
    inventoryTracking: { type: Boolean, default: true },

    // ── SECTION 4: Appearance & Branding ────────────────────
    description: { type: String, trim: true }, // Product Narrative
    shortDescription: { type: String, trim: true },
    tags: [String],
    isFeatured: { type: Boolean, default: false },
    isTrending: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date },
    archivedAt: { type: Date },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deleteReason: { type: String, trim: true },
    source: { type: String, enum: ['manual', 'procurement', 'imported', 'api_created'], default: 'manual' },
    originType: { type: String, enum: ['PROCUREMENT', 'MANUAL', 'IMPORTED', 'API_CREATED'], default: 'MANUAL' },

    // ── SECTION 5: Media Center ─────────────────────────────
    thumbnail: { type: String },
    images: [{ type: String }],
    video: { type: String },

    // ── SECTION 5.5: Visual Identity (Modern) ───────────────
    laptopImage: { type: String },
    tabletImage: { type: String },
    mobileImage: { type: String },
    fit: { type: String, default: 'cover' },
    cardFit: { type: String, default: 'cover' },
    detailFit: { type: String, default: 'contain' },
    position: { type: String, default: 'center' },
    scale: { type: Number, default: 1 },
    gravity: { type: String, default: 'auto' },
    bgStyle: { type: String, default: 'ambient' },

    // ── SECTION 6: Variants ─────────────────────────────────
    variants: [{
      size: { type: String },
      color: { type: String },
      sku: { type: String },
      barcode: { type: String },
      price: { type: Number }, // Override global price if needed
      available: { type: Number, default: 0 },
      totalStock: { type: Number, default: 0 },
      onlineEnabled: { type: Boolean, default: true },
      offlineEnabled: { type: Boolean, default: true },
      images: [{ type: String }],
      thumbnail: { type: String },
      isDeleted: { type: Boolean, default: false }
    }],

    // ── SECTION 7: Sales Channel Control ────────────────────
    isInventoryProduct: { type: Boolean, default: true },
    isOnlineProduct: { type: Boolean, default: true },
    isBillingProduct: { type: Boolean, default: true },
    isManualProduct: { type: Boolean, default: true }, // Set based on creation source
    isProcurementProduct: { type: Boolean, default: false },

    // SEO
    seo: {
      metaTitle: String,
      metaDescription: String,
      keywords: [String],
    },
    
    // Performance Tracking
    viewCount: { type: Number, default: 0 },
    salesCount: { type: Number, default: 0 },
    ratings: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      count: { type: Number, default: 0 },
    }
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Calculate totals and statuses before save
productSchema.pre('save', async function () {
  // 1. Calculate Discounted Price logic
  if (this.discountPercentage > 0) {
    this.discountAmount = Math.round((this.sellingPrice * this.discountPercentage) / 100);
    this.discountedPrice = this.sellingPrice - this.discountAmount;
  } else {
    this.discountAmount = 0;
    this.discountedPrice = this.sellingPrice;
  }

  // 1.5. Visual Identity Fallback (Ensure shop & POS compatibility)
  const visualImages = [this.laptopImage, this.tabletImage, this.mobileImage].filter(Boolean);
  if (this.images.length === 0 && visualImages.length > 0) {
    this.images = visualImages;
  }
  if (!this.thumbnail && this.images.length > 0) {
    this.thumbnail = this.images[0];
  }

  // 2. Stock aggregation logic removed — Use stockService.syncProductStockSummary() instead


  // 4. Calculate Profit Margin
  if (this.costPrice > 0) {
    this.profitMargin = ((this.sellingPrice - this.costPrice) / this.costPrice) * 100;
  } else {
    this.profitMargin = 0;
  }

  // 5. Generate Slug if missing or name is modified (and slug is not explicitly updated)
  if (!this.slug || (this.isModified('name') && !this.isModified('slug'))) {
    const baseSlug = slugify(this.name, { lower: true, strict: true });
    this.slug = `${baseSlug}-${Math.random().toString(36).substring(2, 7)}`;
  }
});

productSchema.plugin(leanVirtuals);
// ── Indexes ────────────────────────────────────────────────
productSchema.index({ name: 'text', subtitle: 'text', description: 'text', tags: 'text', brand: 'text' });
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1 });
productSchema.index({ isDeleted: 1 });
productSchema.index({ createdAt: -1 });
// ── HIGH-PERFORMANCE COMPOUND INDEXES ────────────────
// Admin product list: most common query pattern
productSchema.index({ isDeleted: 1, isArchived: 1, isActive: 1, createdAt: -1 });
// POS/Billing product fetch
productSchema.index({ isBillingProduct: 1, isDeleted: 1, isArchived: 1, isActive: 1 });
// Online storefront fetch
productSchema.index({ isOnlineProduct: 1, isDeleted: 1, isArchived: 1, isActive: 1, createdAt: -1 });
// Category-filtered queries
productSchema.index({ category: 1, isDeleted: 1, isArchived: 1, isActive: 1, createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);
