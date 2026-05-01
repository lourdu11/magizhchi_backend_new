const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true },
  productImage: { type: String },
  sku: { type: String },
  hsnCode: { type: String, default: '6205' },
  variant: {
    size: { type: String, required: true },
    color: { type: String, required: true },
  },
  quantity: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  taxableValue: { type: Number },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  total: { type: Number, required: true },
});

const addressSnapshot = new mongoose.Schema({
  name: String,
  phone: String,
  addressLine1: String,
  addressLine2: String,
  city: String,
  state: String,
  pincode: String,
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, unique: true, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    isGuestOrder: { type: Boolean, default: false },
    guestDetails: {
      name: String,
      email: String,
      phone: String,
    },
    items: [orderItemSchema],
    pricing: {
      subtotal: { type: Number, required: true },
      productDiscount: { type: Number, default: 0 },
      couponDiscount: { type: Number, default: 0 },
      gstAmount: { type: Number, default: 0 },
      shippingCharges: { type: Number, default: 0 },
      totalAmount: { type: Number, required: true },
    },
    shippingAddress: addressSnapshot,
    billingAddress: addressSnapshot,
    paymentMethod: {
      type: String,
      enum: ['razorpay', 'cod', 'upi'],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentDetails: {
      razorpayOrderId: String,
      razorpayPaymentId: String,
      razorpaySignature: String,
      transactionId: String,
      paidAt: Date,
    },
    orderStatus: {
      type: String,
      enum: ['placed', 'confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'cancelled', 'returned'],
      default: 'placed',
    },
    statusHistory: [
      {
        status: String,
        updatedAt: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        note: String,
      },
    ],
    trackingInfo: {
      carrier: String,
      trackingNumber: String,
      trackingUrl: String,
    },
    estimatedDeliveryDate: Date,
    deliveredAt: Date,
    couponCode: String,
    invoiceUrl: String,
    invoiceNumber: String,
    gstin: String,
    notes: String,
    adminNotes: String,
    cancelReason: String,
    returnRequest: {
      isRequested: { type: Boolean, default: false },
      requestedAt: Date,
      reason: String,
      images: [String],
      status: { type: String, enum: ['pending', 'approved', 'rejected'] },
      refundAmount: Number,
      refundedAt: Date,
      adminNote: String,
    },
  },
  { timestamps: true }
);

// Indexes — orderNumber/userId already indexed in schema field definitions
orderSchema.index({ orderStatus: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ 'items.productId': 1 });
orderSchema.index({ 'items.inventoryId': 1 });


module.exports = mongoose.model('Order', orderSchema);
