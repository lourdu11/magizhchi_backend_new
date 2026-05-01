const Wastage = require('../models/Wastage');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');

/**
 * Record stock loss (Wastage)
 * ERP Logic: Reduce stock and log detailed movement
 */
exports.createWastage = async (req, res, next) => {
  try {
    const { inventoryId, quantity, reason, notes } = req.body;

    if (!inventoryId || !quantity || !reason) {
      return ApiResponse.error(res, 'All fields are required', 400);
    }

    // 1. Fetch inventory item
    const inv = await Inventory.findById(inventoryId);
    if (!inv) return ApiResponse.notFound(res, 'Inventory item not found');

    // 2. Check if enough stock exists
    if (inv.availableStock < quantity) {
      return ApiResponse.error(res, `Insufficient stock. Current available: ${inv.availableStock}`, 400);
    }

    const stockBefore = inv.availableStock;

    // 3. Update inventory (Increment damaged count)
    inv.damaged += Number(quantity);
    await inv.save();

    const stockAfter = inv.availableStock;

    // 4. Create wastage record
    const wastage = await Wastage.create({
      inventoryId,
      productName: inv.productName,
      color: inv.color,
      size: inv.size,
      quantity,
      reason,
      notes,
      costPriceAtTime: inv.purchasePrice,
      lossAmount: inv.purchasePrice * quantity,
      reportedBy: req.user.name
    });

    // 5. Create stock movement log
    await StockMovement.create({
      inventoryId,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'damage',
      quantity: -Number(quantity),
      stockBefore,
      stockAfter,
      reason: `Wastage Logged: ${reason}`,
      performedBy: req.user._id,
      referenceId: wastage._id
    });

    return ApiResponse.created(res, wastage, 'Wastage recorded successfully');
  } catch (error) { next(error); }
};

exports.getWastageHistory = async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const wastage = await Wastage.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    
    const total = await Wastage.countDocuments();

    return ApiResponse.paginated(res, wastage, { total, page, limit });
  } catch (error) { next(error); }
};
