const express = require('express');
const r = express.Router();
const { protect } = require('../middlewares/auth');
const User = require('../models/User');
const ApiResponse = require('../utils/apiResponse');

// GET /users/profile
r.get('/profile', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    return ApiResponse.success(res, user);
  } catch (e) { next(e); }
});

// PUT /users/profile
r.put('/profile', protect, async (req, res, next) => {
  try {
    const { name, phone, profilePicture, gstin } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { name, phone, profilePicture, gstin },
      { new: true, runValidators: true }
    ).select('-password');
    return ApiResponse.success(res, user, 'Profile updated');
  } catch (e) { next(e); }
});

// PUT /users/change-password
r.put('/change-password', protect, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return ApiResponse.error(res, 'Current password is incorrect', 400);
    user.password = newPassword;
    await user.save();
    return ApiResponse.success(res, null, 'Password changed successfully');
  } catch (e) { next(e); }
});

// POST /users/addresses
r.post('/addresses', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    // If this is the first address or isDefault is true, unset others
    if (req.body.isDefault || user.addresses.length === 0) {
      user.addresses.forEach(a => { a.isDefault = false; });
      req.body.isDefault = true;
    }
    user.addresses.push(req.body);
    await user.save();
    const updated = await User.findById(req.user._id).select('-password');
    return ApiResponse.success(res, updated, 'Address added');
  } catch (e) { next(e); }
});

// PUT /users/addresses/:id
r.put('/addresses/:id', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const address = user.addresses.id(req.params.id);
    if (!address) return ApiResponse.notFound(res, 'Address not found');
    if (req.body.isDefault) user.addresses.forEach(a => { a.isDefault = false; });
    Object.assign(address, req.body);
    await user.save();
    const updated = await User.findById(req.user._id).select('-password');
    return ApiResponse.success(res, updated, 'Address updated');
  } catch (e) { next(e); }
});

// DELETE /users/addresses/:id
r.delete('/addresses/:id', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const wasDefault = user.addresses.id(req.params.id)?.isDefault;
    user.addresses.pull(req.params.id);
    
    // If we deleted the default, make the first one default
    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }
    
    await user.save();
    const updated = await User.findById(req.user._id).select('-password');
    return ApiResponse.success(res, updated, 'Address removed');
  } catch (e) { next(e); }
});

// GET /users/wallet
r.get('/wallet', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('wallet');
    return ApiResponse.success(res, user.wallet);
  } catch (e) { next(e); }
});

// GET /users/orders (alias - routes to order controller pattern)
r.get('/orders', protect, async (req, res, next) => {
  try {
    const Order = require('../models/Order');
    const orders = await Order.find({ userId: req.user._id }).sort('-createdAt');
    return ApiResponse.success(res, orders);
  } catch (e) { next(e); }
});

module.exports = r;
