const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'Coupon code is required'],
    unique: true,
    uppercase: true,
    trim: true,
  },
  description: String,
  discountType: {
    type: String,
    enum: ['percentage', 'fixed'],
    default: 'percentage',
  },
  discountValue: {
    type: Number,
    required: true,
  },
  minPurchaseAmount: {
    type: Number,
    default: 0,
  },
  maxDiscountAmount: {
    type: Number, // Only relevant for percentage discounts
  },
  validFrom: {
    type: Date,
    default: Date.now,
  },
  validTo: {
    type: Date,
    required: [true, 'Expiry date is required'],
  },
  usageLimit: {
    total: Number, // Max total uses for everyone
    perUser: {
      type: Number,
      default: 1, // Max uses per individual user
    }
  },
  usageCount: {
    type: Number,
    default: 0,
  },
  applicableProducts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
  }],
  usedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Check if coupon is currently valid
couponSchema.methods.isValid = function() {
  const now = new Date();
  return this.isActive && now >= this.validFrom && now <= this.validTo;
};

module.exports = mongoose.model('Coupon', couponSchema);
