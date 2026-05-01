const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variant: {
    size: { type: String, required: true },
    color: { type: String, required: true },
  },
  quantity: { type: Number, required: true, min: 1, max: 10 },
  addedAt: { type: Date, default: Date.now },
});

const cartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
    items: [cartItemSchema],
  },
  { timestamps: true }
);

// userId unique index already declared in schema field definition


module.exports = mongoose.model('Cart', cartSchema);
