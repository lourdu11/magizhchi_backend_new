const { v4: uuidv4 } = require('uuid');

/**
 * Generate Order Number: ORD-20260421-A3F7B2
 * Uses timestamp + random hex to prevent duplicates
 */
const generateOrderNumber = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const unique = Date.now().toString(36).toUpperCase().slice(-4) +
    Math.random().toString(36).toUpperCase().slice(-2);
  return `ORD-${dateStr}-${unique}`;
};

/**
 * Generate Bill Number: BILL-20260421-A3F7B2
 */
const generateBillNumber = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const unique = Date.now().toString(36).toUpperCase().slice(-4) +
    Math.random().toString(36).toUpperCase().slice(-2);
  return `BILL-${dateStr}-${unique}`;
};

/**
 * Generate Invoice Number: INV-20260421-A3F7B2
 */
const generateInvoiceNumber = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const unique = Date.now().toString(36).toUpperCase().slice(-4) +
    Math.random().toString(36).toUpperCase().slice(-2);
  return `INV-${dateStr}-${unique}`;
};

/**
 * Generate Purchase Number: PUR-20260421-A3F7B2
 */
const generatePurchaseNumber = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const unique = Date.now().toString(36).toUpperCase().slice(-4) +
    Math.random().toString(36).toUpperCase().slice(-2);
  return `PUR-${dateStr}-${unique}`;
};


/**
 * Generate 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Generate SKU: MG-CAT-XXXX
 */
const generateSKU = (category = 'GEN') => {
  const prefix = category.toUpperCase().slice(0, 3);
  const random = Math.floor(1000 + Math.random() * 9000);
  return `MG-${prefix}-${random}`;
};

const Counter = require('../models/Counter');

const getNextSequence = async (id, session = null) => {
  const options = { new: true, upsert: true };
  if (session) options.session = session;

  const counter = await Counter.findOneAndUpdate(
    { id },
    { $inc: { seq: 1 } },
    options
  );
  return counter.seq;
};

module.exports = {
  generateOrderNumber,
  generateBillNumber,
  generateInvoiceNumber,
  generatePurchaseNumber,
  generateOTP,
  generateSKU,
  getNextSequence,
};
