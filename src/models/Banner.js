const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Banner title is required'],
  },
  desktopImage: {
    type: String,
    required: [true, 'Desktop image is required'],
  },
  mobileImage: {
    type: String, // Optimized for mobile screens
  },
  link: {
    type: String,
    default: '/',
  },
  displayOrder: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  type: {
    type: String,
    enum: ['hero', 'category', 'popup'],
    default: 'hero',
  },
  validFrom: Date,
  validTo: Date,
}, { timestamps: true });

module.exports = mongoose.model('Banner', bannerSchema);
