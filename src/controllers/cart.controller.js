const Cart = require('../models/Cart');
const Product = require('../models/Product');
const ApiResponse = require('../utils/apiResponse');

exports.getCart = async (req, res, next) => {
  try {
    let cart = await Cart.findOne({ userId: req.user._id })
      .populate('items.productId', 'name images sellingPrice discountedPrice isActive');
    if (!cart) cart = { items: [] };
    return ApiResponse.success(res, { cart });
  } catch (error) { next(error); }
};

exports.addToCart = async (req, res, next) => {
  try {
    const { productId, size, color, quantity = 1 } = req.body;
    const product = await Product.findById(productId);
    if (!product || !product.isActive) return ApiResponse.notFound(res, 'Product not found');

    // ─── BUG FIX: Check availability from Inventory (not legacy Product.variants) ─
    const Inventory = require('../models/Inventory');
    const invItem = await Inventory.findOne({
      productName: product.name, size, color, onlineEnabled: true,
    });
    if (!invItem) return ApiResponse.error(res, 'This variant is not available for online purchase', 404);

    const available = invItem.totalStock - invItem.onlineSold - invItem.offlineSold
      - (invItem.reservedStock || 0) + invItem.returned - invItem.damaged;
    if (available < quantity) return ApiResponse.error(res, `Only ${Math.max(0, available)} items available`, 400);

    let cart = await Cart.findOne({ userId: req.user._id });
    if (!cart) cart = await Cart.create({ userId: req.user._id, items: [] });

    const existingIdx = cart.items.findIndex(
      i => i.productId.toString() === productId && i.variant.size === size && i.variant.color === color
    );

    if (existingIdx > -1) {
      cart.items[existingIdx].quantity = Math.min(available, cart.items[existingIdx].quantity + quantity);
    } else {
      cart.items.push({ productId, variant: { size, color }, quantity });
    }

    await cart.save();
    await cart.populate('items.productId', 'name images sellingPrice discountedPrice');
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
