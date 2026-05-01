const mongoose = require('mongoose');

const billItemSchema = new mongoose.Schema({
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' },
  productName: { type: String, required: true },
  sku:         String,
  hsnCode:     { type: String, default: '6205' },
  variant:     { size: String, color: String },
  quantity:    { type: Number, required: true, min: 1 },
  price:       { type: Number, required: true },
  taxableValue: Number,
  cgst:        { type: Number, default: 0 },
  sgst:        { type: Number, default: 0 },
  total:       { type: Number, required: true },
});

const billSchema = new mongoose.Schema(
  {
    billNumber: { type: String, unique: true, required: true },
    billDate:   { type: Date, default: Date.now },
    staffId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    commissionAmount: { type: Number, default: 0 },
    customerDetails: {
      name: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
    },
    items: [billItemSchema],
    taxType: { type: String, enum: ['regular', 'composition', 'none'], default: 'regular' },
    pricing: {
      subtotal:    { type: Number, required: true },
      discount:    { type: Number, default: 0 },
      discountType: { type: String, enum: ['flat', 'percentage', 'offer'], default: 'flat' },
      gstAmount:   { type: Number, default: 0 },
      roundOff:    { type: Number, default: 0 },
      totalAmount: { type: Number, required: true },
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'card', 'upi', 'split', 'gpay', 'phonepe'],
      required: true,
    },
    paymentDetails: {
      cashAmount: { type: Number, default: 0 },
      cardAmount: { type: Number, default: 0 },
      upiAmount:  { type: Number, default: 0 },
      upiTransactionId: String,
    },
    shopInfo: {
      name:    String,
      address: String,
      gst:     String,
    },
    receiptUrl: String,
    notes:      String,
    isExchange: { type: Boolean, default: false },
    originalBillId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
  },
  { timestamps: true }
);

// billNumber unique index already declared in schema field definition
billSchema.index({ staffId: 1 });
billSchema.index({ createdAt: -1 });
billSchema.index({ 'items.productId': 1 });
billSchema.index({ 'items.inventoryId': 1 });


module.exports = mongoose.model('Bill', billSchema);
