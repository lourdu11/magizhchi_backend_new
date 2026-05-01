const Razorpay = require('razorpay');

// Only init Razorpay if keys are configured
const isConfigured = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

let razorpay;
if (isConfigured) {

  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
} else {
  razorpay = {
    orders: {
      create: async () => {
        throw new Error('Razorpay not configured properly. Please use Cash on Delivery.');
      },
    },
  };
}

module.exports = { razorpay, isConfigured };


