const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    sku: { type: String, unique: true, uppercase: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    brand: { type: String, trim: true, default: 'Magizhchi' },
    description: { type: String, trim: true },
    shortDescription: { type: String, trim: true },
    images: [{ type: String }],
    costPrice: { type: Number, min: 0, default: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    discountPercentage: { type: Number, default: 0, min: 0, max: 100 },
    discountedPrice: { type: Number },
    specifications: {
      fabric: { type: String },
      fit: { type: String },
      weight: { type: String },
      careInstructions: { type: String },
      occasion: { type: String },
      rise: { type: String },
    },
    gstPercentage: { type: Number, default: 12 },
    hsnCode: { type: String, default: '6205' },
    sizeChart: { type: String },
    tags: [String],
    lowStockThreshold: { type: Number, default: 10 },
    isFeatured: { type: Boolean, default: false },
    isBestSeller: { type: Boolean, default: false },
    isNewArrival: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    
    // ── e-Commerce Policy ──────────────────────────────────
    codEnabled: { type: Boolean, default: true },
    isReturnable: { type: Boolean, default: true },
    deliveryEstimate: { type: String, default: '3-5 business days' },

    seo: {
      metaTitle: String,
      metaDescription: String,
      keywords: [String],
    },
    ratings: {
      average: { type: Number, default: 0, min: 0, max: 5 },
      count: { type: Number, default: 0 },
    },
    viewCount: { type: Number, default: 0 },
    salesCount: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

// Indexes
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ category: 1 });
productSchema.index({ isActive: 1 });
productSchema.index({ isFeatured: 1 });
productSchema.index({ isBestSeller: 1 });
productSchema.index({ isNewArrival: 1 });
productSchema.index({ 'ratings.average': -1 });
productSchema.index({ createdAt: -1 });

// Calculate discountedPrice before save
productSchema.pre('save', function (next) {
  if (this.discountPercentage > 0) {
    this.discountedPrice = Math.round(
      this.sellingPrice - (this.sellingPrice * this.discountPercentage) / 100
    );
  } else {
    this.discountedPrice = this.sellingPrice;
  }
  if (typeof next === 'function') next();
});

module.exports = mongoose.model('Product', productSchema);
