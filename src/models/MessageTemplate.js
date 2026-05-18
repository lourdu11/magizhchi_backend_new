const mongoose = require('mongoose');

const messageTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    content: { type: String, required: true },
    category: { 
      type: String, 
      enum: ['Festival', 'New Arrival', 'Promotion', 'Payment Reminder', 'Order Update', 'Other'],
      default: 'Promotion'
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
