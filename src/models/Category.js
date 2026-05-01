const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true },
    image: { type: String },
    parentCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    isActive: { type: Boolean, default: true },
    sizeChart: { type: String }, // URL to size chart image
    displayOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Indexes — slug unique already set in schema field
categorySchema.index({ isActive: 1 });
categorySchema.index({ displayOrder: 1 });


module.exports = mongoose.model('Category', categorySchema);
