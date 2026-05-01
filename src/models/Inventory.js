const mongoose = require('mongoose');
const leanVirtuals = require('mongoose-lean-virtuals');

const inventorySchema = new mongoose.Schema(
  {
    // ── Product Identity ───────────────────────────────────
    productName: { type: String, required: true, trim: true },
    category:    { type: String, trim: true, default: 'Uncategorized' },
    color:       { type: String, required: true, trim: true },
    size:        { type: String, required: true, trim: true },
    sku:         { type: String, trim: true, uppercase: true },
    barcode:     { type: String, trim: true },

    // Optional link to Product collection (for display settings)
    productRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },

    // ── Stock Counters ─────────────────────────────────────
    totalStock:    { type: Number, default: 0, min: 0 }, // All purchased qty
    onlineSold:    { type: Number, default: 0, min: 0 }, // Sold via online orders
    offlineSold:   { type: Number, default: 0, min: 0 }, // Sold via POS bills
    reservedStock: { type: Number, default: 0, min: 0 }, // Online pending payment
    returned:      { type: Number, default: 0, min: 0 }, // Customer returns
    damaged:       { type: Number, default: 0, min: 0 }, // Damaged / written off

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
    maxDiscountPercent: { type: Number, default: 100, min: 0, max: 100 },

    // ── Thresholds ───────────────────────────────────────────
    lowStockThreshold: { type: Number, default: 5 },
    
    // ── Optimized Fields ──────────────────────────────────────
    availableStock: { type: Number, default: 0, index: true },

    // ── Media Assets (Pulled from Procurement) ────────────────
    images: [{ type: String }],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Virtual: Remaining to Allocate ────────────────────────
inventorySchema.virtual('remainingToAllocate').get(function () {
  return Math.max(0, this.availableStock - (this.onlineAllocatedStock || 0) - (this.offlineAllocatedStock || 0));
});

// ── Pre-save: Calculate Available Stock ───────────────────
inventorySchema.pre('save', function () {
  this.availableStock = Math.max(
    0,
    (this.totalStock || 0) - 
    (this.onlineSold || 0) - 
    (this.offlineSold || 0) - 
    (this.reservedStock || 0) + 
    (this.returned || 0) - 
    (this.damaged || 0)
  );
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
inventorySchema.index({ productRef: 1 });
inventorySchema.index({ productName: 'text', category: 'text' });

inventorySchema.plugin(leanVirtuals);

module.exports = mongoose.model('Inventory', inventorySchema);
