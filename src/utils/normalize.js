/**
 * Normalizes a phone number to a consistent 10-digit format for the Indian market.
 * Removes all non-digit characters and strips +91 or 0 prefixes.
 */
const normalizePhone = (phone) => {
  if (!phone) return '';
  // Remove all non-digits
  let digits = phone.replace(/\D/g, '');
  
  // If it's a 12-digit number starting with 91, take last 10
  if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(-10);
  }
  
  // If it's an 11-digit number starting with 0, take last 10
  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(-10);
  }
  
  return digits;
};

module.exports = { normalizePhone };
