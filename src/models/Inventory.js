const mongoose = require('mongoose');
const leanVirtuals = require('mongoose-lean-virtuals');

const inventorySchema = new mongoose.Schema(
  {
    // ── Product Identity ───────────────────────────────────
    productName: { type: String, required: true, trim: true },
    category:    { type: String, trim: true, default: 'Uncategorized' },
    color:       { type: String, trim: true, default: '' },
    size:        { type: String, required: true, trim: true },
    sku:         { type: String, trim: true, uppercase: true },
    barcode:     { type: String, trim: true },

    // Optional link to Product collection (for display settings)
    productRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    
    // 🚀 NEW: Link to Procurement Source
    procurementProductId: { type: String, trim: true },
    sourcePurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
    sourceBillId: { type: String, trim: true },
    sourceVendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },

    // ── Stock Counters ─────────────────────────────────────
    totalStock:    { type: Number, default: 0 }, // All purchased qty
    onlineSold:    { type: Number, default: 0, min: 0 }, // Sold via online orders
    offlineSold:   { type: Number, default: 0, min: 0 }, // Sold via POS bills
    reservedStock: { type: Number, default: 0, min: 0 }, // Online pending payment
    returned:      { type: Number, default: 0, min: 0 }, // Customer returns
    damaged:       { type: Number, default: 0, min: 0 }, // Damaged / written off
    
    // 🛡️ RESERVATION LEDGER (Phase 2 Hardening)
    reservations: [{
      orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
      quantity:  { type: Number, required: true },
      expiresAt: { type: Date, required: true },
      createdAt: { type: Date, default: Date.now }
    }],
    reservationExpiresAt: { type: Date, index: true }, // Soonest expiry for cleanup job

    // ── Pricing ─────────────────────────────────────────────
    purchasePrice: { type: Number, default: 0, min: 0 },
    sellingPrice:  { type: Number, default: 0, min: 0 },
    gstPercentage: { type: Number, default: 5 },

    // ── Channel Toggles & Allocation ────────────────────────
    onlineEnabled:         { type: Boolean, default: true },
    onlineAllocatedStock:  { type: Number, default: 0, min: 0 },
    offlineEnabled:        { type: Boolean, default: true },
    offlineAllocatedStock: { type: Number, default: 0, min: 0 },

    // ── POS Specifics ────────────────────────────────────────
    posDisplayName:     { type: String, trim: true },
    posCategory:        { type: String, trim: true },
    isDiscountAllowed:  { type: Boolean, default: true },
    maxDiscountPercent: { type: Number, default: 50, min: 0, max: 100 },

    // ── Thresholds ───────────────────────────────────────────
    lowStockThreshold: { type: Number, default: 5 },
    
    // ── Optimized Fields ──────────────────────────────────────
    availableStock: { type: Number, default: 0, index: true, min: [0, 'Stock cannot be negative'] },

    // ── Media Assets (Pulled from Procurement) ────────────────
    images: [{ type: String }],
    laptopImage: { type: String },
    tabletImage: { type: String },
    mobileImage: { type: String },

    // ── Archival / Soft-Delete ──────────────────────────────
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── INDEXES ──────────────────────────────────────────────
inventorySchema.index({ productRef: 1, isDeleted: 1 });
inventorySchema.index({ sku: 1 }, { unique: true, sparse: true });
inventorySchema.index({ barcode: 1 }, { sparse: true });
inventorySchema.index({ 'reservations.expiresAt': 1 });

// ── Virtual: Remaining to Allocate ────────────────────────
inventorySchema.virtual('remainingToAllocate').get(function () {
  return Math.max(0, this.availableStock - (this.onlineAllocatedStock || 0) - (this.offlineAllocatedStock || 0));
});

// ── Virtual: Status ────────────────────────────────────────
inventorySchema.virtual('status').get(function () {
  const avail = this.availableStock;
  if (avail === 0) return 'out_of_stock';
  if (avail <= this.lowStockThreshold) return 'low_stock';
  return 'in_stock';
});

// ── Indexes ────────────────────────────────────────────────
inventorySchema.index({ productName: 1, color: 1, size: 1 }, { unique: true });
inventorySchema.index({ category: 1 });
inventorySchema.index({ onlineEnabled: 1 });
inventorySchema.index({ offlineEnabled: 1 });
inventorySchema.index({ productName: 'text', category: 'text', color: 'text' });

// ── HIGH-PERFORMANCE COMPOUND INDEXES ────────────────
// POS channel query: offlineEnabled products by stock (most common POS query)
inventorySchema.index({ offlineEnabled: 1, isDeleted: 1, isArchived: 1, availableStock: -1 });
// Online channel query: onlineEnabled products
inventorySchema.index({ onlineEnabled: 1, isDeleted: 1, isArchived: 1, availableStock: -1 });
// Admin inventory lookup: by product ref and status
inventorySchema.index({ productRef: 1, isDeleted: 1, isArchived: 1, availableStock: -1 });
// Dashboard low-stock alert query
inventorySchema.index({ isDeleted: 1, isArchived: 1, availableStock: 1, lowStockThreshold: 1 });

inventorySchema.plugin(leanVirtuals);


inventorySchema.post('save', function(doc) {
  if (doc.availableStock <= doc.lowStockThreshold) {
    const { getIO } = require('../utils/socket');
    const io = getIO();
    io.emit('low_stock_alert', {
      inventoryId: doc._id,
      productName: doc.productName,
      sku: doc.sku,
      availableStock: doc.availableStock,
      threshold: doc.lowStockThreshold
    });
  }
});

module.exports = mongoose.model('Inventory', inventorySchema);
