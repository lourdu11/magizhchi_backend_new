const mongoose = require('mongoose');
const logger = require('./logger');

let transactionsSupported = null;

/**
 * Checks if the current MongoDB connection supports transactions.
 * Probes the capabilities once and caches the result.
 */
async function checkTransactionSupport() {
  if (transactionsSupported !== null) return transactionsSupported;

  try {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      // Execute a quick, harmless probe read
      await mongoose.connection.db.collection('users').findOne({}, { session });
      await session.commitTransaction();
      transactionsSupported = true;
      logger.info('🚀 Database Transactions: SUPPORTED (Replica Set / Atlas / mongos)');
    } catch (e) {
      await session.endSession();
      transactionsSupported = false;
      logger.warn('⚠️ Database Transactions: NOT SUPPORTED (Standalone Local MongoDB). Falling back to non-transactional execution.');
    } finally {
      await session.endSession();
    }
  } catch (error) {
    transactionsSupported = false;
    logger.warn('⚠️ Database Transactions: NOT SUPPORTED (Session start failed). Falling back to non-transactional execution.');
  }

  return transactionsSupported;
}

/**
 * Starts a transaction session if supported, otherwise returns a mock session object.
 */
async function startTransactionSession() {
  const supported = await checkTransactionSupport();
  if (!supported) {
    return {
      session: null,
      inTransaction: () => false,
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: async () => {}
    };
  }

  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    return {
      session,
      inTransaction: () => session.inTransaction(),
      commitTransaction: async () => { 
        if (session.inTransaction()) {
          await session.commitTransaction(); 
        }
      },
      abortTransaction: async () => { 
        if (session.inTransaction()) {
          await session.abortTransaction(); 
        }
      },
      endSession: async () => { 
        await session.endSession(); 
      }
    };
  } catch (err) {
    logger.error('Failed to start transaction session:', err.message);
    return {
      session: null,
      inTransaction: () => false,
      commitTransaction: async () => {},
      abortTransaction: async () => {},
      endSession: async () => {}
    };
  }
}

module.exports = {
  checkTransactionSupport,
  startTransactionSession
};
