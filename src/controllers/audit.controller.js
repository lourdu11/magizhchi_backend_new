const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');

/**
 * ERP Stock Audit (Reconciliation)
 * Compares system stock vs physical count
 */
exports.reconcileStock = async (req, res, next) => {
  try {
    const { inventoryId, physicalCount, reason } = req.body;

    if (!inventoryId || physicalCount === undefined) {
      return ApiResponse.error(res, 'Inventory ID and Physical Count are required', 400);
    }

    const inv = await Inventory.findById(inventoryId);
    if (!inv) return ApiResponse.notFound(res, 'Inventory item not found');

    const systemStock = inv.availableStock;
    const difference = physicalCount - systemStock;

    if (difference === 0) {
      return ApiResponse.success(res, null, 'Stock matches system. No adjustment needed.');
    }

    const stockBefore = systemStock;

    // Adjust totalStock to match physical count
    // physicalCount = totalStock - online - offline - reserved + returned - damaged
    // We adjust totalStock by the difference
    inv.totalStock += difference;
    await inv.save();

    const stockAfter = inv.availableStock;

    // Log the movement
    await StockMovement.create({
      inventoryId: inv._id,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'audit_correction',
      quantity: difference,
      stockBefore,
      stockAfter,
      reason: `Audit Reconciliation: ${reason || 'Periodic Audit'} (Diff: ${difference})`,
      performedBy: req.user._id
    });

    return ApiResponse.success(res, {
      systemStock,
      physicalCount,
      difference,
      newAvailableStock: inv.availableStock
    }, 'Stock reconciled successfully');
  } catch (error) { next(error); }
};
