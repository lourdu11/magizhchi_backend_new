const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  variant: {
    size: { type: String, required: false }, // Optional for combos
    color: { type: String },
  },
  isCombo: { type: Boolean, default: false },
  comboSelections: [
    {
      productName: { type: String }, // Individual product in the bundle
      size: { type: String },
      color: { type: String },
      id: { type: String } // Variant ID from the combo orchestration
    }
  ],
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
