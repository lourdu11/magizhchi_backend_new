const mongoose = require('mongoose');

const broadcastLogSchema = new mongoose.Schema(
  {
    broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false }, // Optional for offline customers
    customerName: { type: String, required: true }, // Store name for personalization
    phone: { type: String, required: true },
    status: { 
      type: String, 
      enum: ['pending', 'sent', 'delivered', 'failed'], 
      default: 'pending' 
    },
    messageId: { type: String, index: true },
    error: { type: String, default: null },
    sentAt: { type: Date },
    deliveredAt: { type: Date }
  },
  { timestamps: true }
);

broadcastLogSchema.index({ phone: 1 });
broadcastLogSchema.index({ status: 1 });
broadcastLogSchema.index({ createdAt: -1 });
broadcastLogSchema.index({ broadcastId: 1, status: 1 });
broadcastLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

module.exports = mongoose.model('BroadcastLog', broadcastLogSchema);
