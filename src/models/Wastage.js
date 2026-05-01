const mongoose = require('mongoose');

const wastageSchema = new mongoose.Schema({
  inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
  productName: { type: String, required: true },
  color: String,
  size: String,
  quantity: { type: Number, required: true },
  reason: { 
    type: String, 
    required: true, 
    enum: ['stain', 'missing', 'defect', 'trial_damage', 'missing_stock', 'other'] 
  },
  costPriceAtTime: { type: Number, required: true },
  lossAmount: { type: Number, required: true }, // quantity * costPrice
  reportedBy: { type: String },
  notes: String,
  date: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('Wastage', wastageSchema);
