const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  type: { type: String, enum: ['customer_return', 'supplier_return'], required: true },
  
  // Reference
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' }, // For Customer Return
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' }, // For Supplier Return
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  
  items: [{
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
    productName: String,
    color: String,
    size: String,
    quantity: { type: Number, required: true },
    reason: String,
    price: Number, // Selling price for customer, Cost price for supplier
  }],
  
  totalAmount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'completed', 'cancelled'], default: 'completed' },
  refundMethod: { type: String, enum: ['cash', 'credit_note', 'bank_transfer', 'deduct_from_payable'], default: 'credit_note' },
  date: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Return', returnSchema);
