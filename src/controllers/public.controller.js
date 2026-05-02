const Contact = require('../models/Contact');
const ApiResponse = require('../utils/apiResponse');
const { sendContactMessageNotificationToAdmin } = require('../services/whatsapp.service');
const Settings = require('../models/Settings');
const Order = require('../models/Order');

exports.submitContactForm = async (req, res, next) => {
  try {
    const { name, email, phone, subject, message } = req.body;

    // 1. Save to DB
    const contact = await Contact.create({ name, email, phone, subject, message });

    // 2. Send Notifications (WhatsApp & Email)
    const settings = await Settings.findOne() || {};
    const contactNotif = settings.notifications?.contactNotifications || { enabled: true, method: 'both' };
    const { sendAdminContactNotificationEmail } = require('../services/email.service');
    
    if (contactNotif.enabled) {
      if (['whatsapp', 'both'].includes(contactNotif.method)) {
        sendContactMessageNotificationToAdmin(contact).catch(() => {});
      }
      if (['email', 'both'].includes(contactNotif.method)) {
        sendAdminContactNotificationEmail(contact).catch(() => {});
      }
    }

    return ApiResponse.success(res, contact, 'Message sent successfully');
  } catch (e) {
    next(e);
  }
};

exports.getPublicSettings = async (req, res, next) => {
  try {
    const settings = await Settings.findOne()
      .select('store shipping payment seo')
      .lean();

    // Provide safe defaults if no settings document exists yet
    const response = {
      store: { name: 'Magizhchi Garments', email: '', phone: '', address: '', gstin: '', ...(settings?.store || {}) },
      shipping: { flatRateTN: 50, flatRateOut: 100, freeShippingThreshold: 999, ...(settings?.shipping || {}) },
      payment: { onlineEnabled: true, codEnabled: true, codCharges: 50, codThreshold: 50000, ...(settings?.payment || {}) },
      seo: settings?.seo || {}
    };
    return ApiResponse.success(res, response);
  } catch (e) {
    next(e);
  }
};

exports.trackOrder = async (req, res, next) => {
  try {
    const { orderNumber, phone } = req.body;

    if (!orderNumber && !phone) {
      return ApiResponse.error(res, 'Please enter Order Number or Phone Number', 400);
    }

    let query = {};

    if (orderNumber) {
      query.orderNumber = orderNumber.toUpperCase();
    }

    if (phone) {
      const cleanPhone = phone.replace(/\D/g, '').slice(-10);
      const phoneQuery = {
        $or: [
          { 'shippingAddress.phone': { $regex: cleanPhone } },
          { 'guestDetails.phone': { $regex: cleanPhone } },
          { 'billingAddress.phone': { $regex: cleanPhone } }
        ]
      };

      if (orderNumber) {
        // If both provided, keep it strict for better security
        query = { ...query, ...phoneQuery };
      } else {
        // If only phone provided, search by phone
        query = phoneQuery;
      }
    }

    // Find the latest order matching the criteria
    const order = await Order.findOne(query)
      .sort({ createdAt: -1 })
      .select('-userId -paymentDetails.razorpaySignature -statusHistory.updatedBy');

    if (!order) {
      return ApiResponse.error(res, 'No matching order found', 404);
    }

    return ApiResponse.success(res, { order });
  } catch (e) {
    next(e);
  }
};

exports.getPublicOrderDetails = async (req, res, next) => {
  try {
    const { id } = req.params;

    const order = await Order.findById(id)
      .select('-userId -paymentDetails.razorpaySignature -statusHistory.updatedBy');

    if (!order) {
      return ApiResponse.error(res, 'Order not found', 404);
    }

    return ApiResponse.success(res, { order });
  } catch (e) {
    next(e);
  }
};

exports.testBrevoEndpoint = async (req, res) => {
  try {
    const { sendAdminOrderNotificationEmail } = require('../services/email.service');
    const dummyOrder = {
      _id: '507f1f77bcf86cd799439011',
      orderNumber: 'TEST-ORDER-BREVO',
      shippingAddress: { name: 'Diagnostic Test', phone: '0000000000' },
      pricing: { totalAmount: 1 },
      paymentMethod: 'TEST',
      items: [{ productName: 'Diagnostic Ping', variant: { size: 'N/A', color: 'N/A' }, quantity: 1 }]
    };

    const response = await sendAdminOrderNotificationEmail(dummyOrder);
    res.json({ success: true, message: 'Brevo API was successfully hit. If you didn\'t receive the email, it is in your Spam folder, or your Brevo account is in Sandbox mode.', brevoRawResponse: response });
  } catch (err) {
    res.json({ success: false, error: err.message, stack: err.stack });
  }
};
