const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, required: true }, // e.g., 'VOID_BILL', 'EDIT_ORDER', 'LOGIN', 'PROCUREMENT_ROLLBACK'
    module: { type: String, required: true }, // e.g., 'BILLING', 'ORDERS', 'AUTH', 'INVENTORY'
    resourceId: { type: String }, // ID of the affected resource (Bill ID, Order ID, etc.)
    details: { type: mongoose.Schema.Types.Mixed }, // JSON payload of what changed
    ipAddress: String,
    userAgent: String,
    status: { type: String, enum: ['success', 'failure'], default: 'success' },
    errorMessage: String,
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ action: 1 });
auditLogSchema.index({ module: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
