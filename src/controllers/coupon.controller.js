const Coupon = require('../models/Coupon');
const ApiResponse = require('../utils/apiResponse');

// Get all coupons (Admin)
exports.getAllCoupons = async (req, res, next) => {
  try {
    const coupons = await Coupon.find().sort('-createdAt');
    return ApiResponse.success(res, coupons);
  } catch (error) { next(error); }
};

// Create coupon (Admin)
exports.createCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.create(req.body);
    return ApiResponse.created(res, coupon, 'Coupon created successfully');
  } catch (error) { next(error); }
};

// Delete coupon (Admin)
exports.deleteCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return ApiResponse.notFound(res, 'Coupon not found');
    return ApiResponse.success(res, null, 'Coupon deleted');
  } catch (error) { next(error); }
};

// Validate coupon (User/Checkout)
exports.validateCoupon = async (req, res, next) => {
  try {
    const { code, amount } = req.body;
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });

    if (!coupon) return ApiResponse.error(res, 'Invalid coupon code', 400);

    const now = new Date();
    if (now < coupon.validFrom || now > coupon.validTo) {
      return ApiResponse.error(res, 'Coupon has expired', 400);
    }

    if (amount < coupon.minPurchaseAmount) {
      return ApiResponse.error(res, `Minimum purchase of Rs.${coupon.minPurchaseAmount} required`, 400);
    }

    if (coupon.usageLimit?.total && coupon.usageCount >= coupon.usageLimit.total) {
      return ApiResponse.error(res, 'Coupon usage limit reached', 400);
    }

    // Per-user limit check
    if (req.user && coupon.usageLimit?.perUser) {
      const timesUsed = coupon.usedBy.filter(id => id.toString() === req.user._id.toString()).length;
      if (timesUsed >= coupon.usageLimit.perUser) {
        return ApiResponse.error(res, `You have already used this coupon the maximum allowed times`, 400);
      }
    }

    // Calculate discount
    let discount = 0;
    if (coupon.discountType === 'percentage') {
      discount = (amount * coupon.discountValue) / 100;
      if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
        discount = coupon.maxDiscountAmount;
      }
    } else {
      discount = coupon.discountValue;
    }

    return ApiResponse.success(res, {
      code: coupon.code,
      discount,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue
    }, 'Coupon applied successfully');

  } catch (error) { next(error); }
};
