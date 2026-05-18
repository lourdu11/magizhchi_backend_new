const AuditLog = require('../models/AuditLog');
const logger = require('./logger');

/**
 * Enterprise Audit Logger Utility
 */
const logAudit = async ({ req, userId, action, module, resourceId, details, status = 'success', errorMessage = null }) => {
  try {
    const logData = {
      userId: userId || req?.user?._id,
      action,
      module,
      resourceId,
      details,
      ipAddress: req?.ip || req?.headers?.['x-forwarded-for'],
      userAgent: req?.headers?.['user-agent'],
      status,
      errorMessage
    };

    if (!logData.userId) {
      logger.warn(`[AuditLogger] Attempted to log '${action}' without userId`);
      return;
    }

    await AuditLog.create(logData);
  } catch (error) {
    logger.error(`[AuditLogger] Failed to save audit log: ${error.message}`);
  }
};

module.exports = { logAudit };
