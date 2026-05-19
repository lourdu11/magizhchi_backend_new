const Cart = require('../models/Cart');
const Product = require('../models/Product');
const ApiResponse = require('../utils/apiResponse');

exports.getCart = async (req, res, next) => {
  try {
    let cart = await Cart.findOne({ userId: req.user._id })
      .populate('items.productId', 'name images sellingPrice discountedPrice isActive isDeleted multiBuyEnabled multiBuyQuantity multiBuyPrice');
    
    if (!cart) {
      return ApiResponse.success(res, { cart: { items: [] } });
    }

    // ── LOGICAL CLEANUP: Auto-remove items for deleted or inactive products ──
    const originalCount = cart.items.length;
    cart.items = cart.items.filter(item => 
      item.productId && 
      item.productId.isActive !== false && 
      item.productId.isDeleted !== true
    );

    if (cart.items.length !== originalCount) {
      await cart.save(); // Silently sync cart state
    }

    return ApiResponse.success(res, { cart });
  } catch (error) { next(error); }
};

exports.addToCart = async (req, res, next) => {
  try {
    let { productId, size, color, quantity = 1, comboSelections, variant } = req.body;
    if (variant) {
      if (!size) size = variant.size;
      if (!color) color = variant.color;
    }

    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return ApiResponse.notFound(res, 'Product not found');
    }
    const product = await Product.findById(productId);
    if (!product) return ApiResponse.notFound(res, 'Product not found');
    
    const isStaffOrAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'staff');
    if (!product.isActive && !isStaffOrAdmin) {
      return ApiResponse.notFound(res, 'Product is currently inactive');
    }

    const Inventory = require('../models/Inventory');
    let cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) cart = await Cart.create({ userId: req.user._id, items: [] });

    // Helper to get aggregate stock for a variant
    const getVariantStock = async (query) => {
      const filter = { ...query, isDeleted: false };
      if (!isStaffOrAdmin) {
        filter.onlineEnabled = true;
      }
      const items = await Inventory.find(filter);
      if (items.length === 0) return { exists: false, available: 0 };
      
      const totalAvailable = items.reduce((sum, inv) => {
        const avail = inv.totalStock - inv.onlineSold - inv.offlineSold
          - (inv.reservedStock || 0) + inv.returned - inv.damaged;
        return sum + Math.max(0, avail);
      }, 0);
      
      return { exists: true, available: totalAvailable };
    };

    // ─── COMBO PRODUCT LOGIC ──────────────────────────────────────
    if (product.productNature === 'combo') {
      if (!comboSelections || comboSelections.length === 0) 
        return ApiResponse.error(res, 'Bundle configuration required', 400);

      // 1. Verify stock for ALL selected items in the bundle
      for (const selection of comboSelections) {
        const stockInfo = await getVariantStock({
          $or: [
            { productRef: selection.productRef, size: { $regex: new RegExp(`^${selection.size}$`, 'i') }, color: { $regex: new RegExp(`^${selection.color}$`, 'i') } },
            { productName: selection.productName, size: { $regex: new RegExp(`^${selection.size}$`, 'i') }, color: { $regex: new RegExp(`^${selection.color}$`, 'i') } }
          ]
        });

        if (!stockInfo.exists && !isStaffOrAdmin) 
          return ApiResponse.error(res, `${selection.productName} (${selection.size}) is not found in active inventory`, 404);
        
        if (stockInfo.available < quantity && !isStaffOrAdmin) 
          return ApiResponse.error(res, `Only ${stockInfo.available} of ${selection.productName} available`, 400);
      }

      // 2. Add to cart (Unique check: same productId + same selections)
      const existingIdx = cart.items.findIndex(i => 
        i.productId && 
        i.productId.toString() === productId && 
        i.isCombo && 
        JSON.stringify(i.comboSelections) === JSON.stringify(comboSelections)
      );

      if (existingIdx > -1) {
        cart.items[existingIdx].quantity = Math.min(10, cart.items[existingIdx].quantity + quantity);
      } else {
        cart.items.push({ productId, isCombo: true, comboSelections, quantity });
      }
    } 
    // ─── STANDALONE PRODUCT LOGIC ─────────────────────────────────
    else {
      const stockInfo = await getVariantStock({
        productRef: product._id, 
        size: { $regex: new RegExp(`^${size}$`, 'i') }, 
        color: { $regex: new RegExp(`^${color}$`, 'i') }
      });

      if (!stockInfo.exists) {
         // Fallback to name-based lookup for legacy items
         const fallback = await getVariantStock({
            productName: product.name,
            size: { $regex: new RegExp(`^${size}$`, 'i') }, 
            color: { $regex: new RegExp(`^${color}$`, 'i') }
         });
         if (!fallback.exists && !isStaffOrAdmin) return ApiResponse.error(res, 'This variant is not available for online purchase', 404);
         stockInfo.available = fallback.available;
      }

      if (stockInfo.available < quantity && !isStaffOrAdmin) {
         return ApiResponse.error(res, `Only ${stockInfo.available} items available`, 400);
      }
 
      const existingIdx = cart.items.findIndex(
        i => i.productId && i.productId.toString() === productId && !i.isCombo && i.variant?.size === size && i.variant?.color === color
      );
 
      if (existingIdx > -1) {
        const newQty = cart.items[existingIdx].quantity + quantity;
        cart.items[existingIdx].quantity = isStaffOrAdmin ? newQty : Math.min(stockInfo.available, newQty);
      } else {
        cart.items.push({ productId, variant: { size, color }, quantity });
      }
    }

    await cart.save();
    await cart.populate('items.productId', 'name images sellingPrice discountedPrice multiBuyEnabled multiBuyQuantity multiBuyPrice');
    return ApiResponse.success(res, { cart }, 'Added to cart');
  } catch (error) { 
    console.error('🔥 AddToCart Error:', error);
    next(error); 
  }
};

exports.updateCartItem = async (req, res, next) => {
  try {
    const { quantity } = req.body;
    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) return ApiResponse.notFound(res, 'Cart not found');

    const item = cart.items.id(req.params.itemId);
    if (!item) return ApiResponse.notFound(res, 'Item not found');

    if (quantity <= 0) {
      item.deleteOne();
    } else {
      // Check real-time Inventory availability before allowing qty increase
      const Inventory = require('../models/Inventory');
      const populatedItem = await cart.populate('items.productId', 'name');
      const productName = item.productId?.name;
      let maxQty = quantity; // default: allow if we can't find inventory

      if (productName) {
        const inv = await Inventory.findOne({
          productName,
          size: item.variant?.size,
          color: item.variant?.color,
          onlineEnabled: true,
        });
        if (inv) {
          const available = inv.totalStock - inv.onlineSold - inv.offlineSold
            - (inv.reservedStock || 0) + inv.returned - inv.damaged;
          maxQty = Math.max(0, available);
        }
      }

      item.quantity = Math.min(maxQty, quantity);
    }

    await cart.save();
    return ApiResponse.success(res, { cart }, 'Cart updated');
  } catch (error) { next(error); }
};

exports.removeFromCart = async (req, res, next) => {
  try {
    const cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) return ApiResponse.notFound(res, 'Cart not found');

    cart.items = cart.items.filter(i => i._id.toString() !== req.params.itemId);
    await cart.save();
    return ApiResponse.success(res, { cart }, 'Item removed');
  } catch (error) { next(error); }
};

exports.clearCart = async (req, res, next) => {
  try {
    await Cart.findOneAndUpdate({ userId: req.user._id }, { items: [] });
    return ApiResponse.success(res, null, 'Cart cleared');
  } catch (error) { next(error); }
};
