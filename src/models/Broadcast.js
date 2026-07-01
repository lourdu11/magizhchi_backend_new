const mongoose = require('mongoose');

const broadcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    mediaUrl: { type: String }, // Legacy
    mediaUrls: [{ type: String }],
    mediaType: { type: String, default: 'none' },
    totalRecipients: { type: Number, default: 0 },
    status: { 
      type: String, 
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'pending'
    },
    stats: {
      pending: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      failed: { type: Number, default: 0 }
    },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Broadcast', broadcastSchema);
