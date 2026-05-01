const mongoose = require('mongoose');

const whatsappSessionSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // e.g., 'baileys-auth'
  data: { type: String, required: true }, // Base64 encoded JSON or raw JSON string
}, { timestamps: true });

module.exports = mongoose.model('WhatsAppSession', whatsappSessionSchema);
