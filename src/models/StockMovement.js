const mongoose = require('mongoose');

const stockMovementSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, // Optional — inventory items may not have a linked product
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory' }, 
    variant: {
      size: { type: String, required: true },
      color: { type: String, required: true },
    },
    type: {
      type: String,
      enum: [
        'purchase', 
        'sale_pos', 
        'sale_online', 
        'return_customer', 
        'return_supplier', 
        'damage', 
        'damage_wastage',
        'audit_correction', 
        'manual', 
        'reserve', 
        'release',
        'exchange_in',
        'exchange_out',
        'sale_correction'
      ],
      required: true,
    },
    quantity: { type: Number, required: true },
    reason: { type: String, required: true },
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    billId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill' },
    stockBefore: { type: Number },
    stockAfter: { type: Number },
    timestamp: { type: Date, default: Date.now },
  }
);

stockMovementSchema.index({ productId: 1 });
stockMovementSchema.index({ timestamp: -1 });
stockMovementSchema.index({ type: 1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);
