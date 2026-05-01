const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  contactPerson: { type: String, trim: true },
  email: { type: String, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  gstin: { type: String, uppercase: true, trim: true },
  address: { type: String, trim: true },
  
  // ── Ledger / Payables Tracking (ERP Upgrade) ──────
  totalPurchaseAmount: { type: Number, default: 0 }, // Sum of all received bills
  totalPaidAmount: { type: Number, default: 0 },    // Sum of all payments
  creditLimit: { type: Number, default: 0 },
  creditDays: { type: Number, default: 30 },
  openingBalance: { type: Number, default: 0 },
  
  payments: [{
    amount: { type: Number, required: true },
    date: { type: Date, default: Date.now },
    method: { type: String, enum: ['Cash', 'UPI', 'Bank', 'Cheque'], default: 'Cash' },
    referenceId: { type: String },
    note: { type: String }
  }],
  isActive: { type: Boolean, default: true },
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for Current Outstanding
supplierSchema.virtual('outstandingBalance').get(function() {
  return (this.openingBalance + this.totalPurchaseAmount) - this.totalPaidAmount;
});

module.exports = mongoose.model('Supplier', supplierSchema);
