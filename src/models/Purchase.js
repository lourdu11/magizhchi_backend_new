const mongoose = require('mongoose');

// Free-text purchase item — no productId ref needed
const purchaseItemSchema = new mongoose.Schema({
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
  productName: { type: String, required: true, trim: true },
  category:    { type: String, trim: true, default: 'Uncategorized' },
  color:       { type: String, trim: true, default: '' },
  size:        { type: String, required: true, trim: true },
  quantity:    { type: Number, required: true, min: 1 },
  costPrice:   { type: Number, required: true, min: 0 },
  gstPercent:  { type: Number, default: 5 },
  sellingPrice: { type: Number, default: 0 },
  total:        { type: Number, default: 0 },
  sku:          { type: String, trim: true },
  barcode:      { type: String, trim: true },
  images:       [{ type: String }],
});

const purchaseSchema = new mongoose.Schema(
  {
    purchaseNumber: { type: String, unique: true, required: true }, // PUR-YYYYMMDD-001
    billNumber:     { type: String, default: '' },
    supplierName:   { type: String, trim: true, default: '' },
    supplierId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    items:          [purchaseItemSchema],
    pricing: {
      subtotal:    { type: Number, default: 0 },
      gstAmount:   { type: Number, default: 0 },
      totalAmount: { type: Number, default: 0 },
      manualFinancialImpact: { type: Number, default: null }
    },
    status: { type: String, enum: ['draft', 'received', 'cancelled'], default: 'received' },
    paidAmount: { type: Number, default: 0 }, // Per bill payment tracking
    paymentStatus: { type: String, enum: ['paid', 'partial', 'pending', 'credit'], default: 'pending' },
    purchaseDate:  { type: Date, default: Date.now },
    notes:         { type: String },
    billImage:     { type: String },
    performedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isDeleted:     { type: Boolean, default: false },
    deletedAt:     Date,
    deletedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Purchase', purchaseSchema);
