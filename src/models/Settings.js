const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    store: {
      name: { type: String, default: 'Magizhchi Garments' },
      logo: String,
      favicon: String,
      email: String,
      phone: String,
      address: String,
      gstin: String,
      whatsapp: String,
    },
    shipping: {
      flatRateTN: { type: Number, default: 50 },
      flatRateOut: { type: Number, default: 100 },
      freeShippingThreshold: { type: Number, default: 999 },
      estimatedDays: {
        metro: { type: Number, default: 3 },
        other: { type: Number, default: 6 },
        remote: { type: Number, default: 10 },
      },
    },
    gst: {
      rate: { type: Number, default: 5 },
      enabled: { type: Boolean, default: true },
      cgst: { type: Number, default: 2.5 },
      sgst: { type: Number, default: 2.5 },
    },
    social: {
      facebook: String,
      instagram: String,
      twitter: String,
      youtube: String,
    },
    payment: {
      onlineEnabled: { type: Boolean, default: true },
      razorpayKeyId: String,
      razorpayKeySecret: { type: String, select: false },
      codEnabled: { type: Boolean, default: true },
      codCharges: { type: Number, default: 50 },
      codThreshold: { type: Number, default: 50000 },
    },
    notifications: {
      email: {
        host: String,
        port: { type: Number, default: 587 },
        user: String,
        password: { type: String, select: false },
        alertEmail: String,
      },
      whatsapp: {
        adminPhone: { type: String, default: '7358885452' },
        apiKey: { type: String, select: false },
      },
      orderNotifications: {
        enabled: { type: Boolean, default: true },
        method: { type: String, enum: ['whatsapp', 'email', 'both'], default: 'both' }
      },
      contactNotifications: {
        enabled: { type: Boolean, default: true },
        method: { type: String, enum: ['whatsapp', 'email', 'both'], default: 'both' }
      },
      lowStockAlert: {
        enabled: { type: Boolean, default: true },
        method: { type: String, enum: ['whatsapp', 'email', 'both'], default: 'both' },
      }
    },

    seo: {
      metaTitle: { type: String, default: 'Magizhchi Garments - Premium Men\'s Clothing' },
      metaDescription: String,
      googleAnalyticsId: String,
      facebookPixelId: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
