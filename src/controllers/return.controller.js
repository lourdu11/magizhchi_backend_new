const Return = require('../models/Return');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const Supplier = require('../models/Supplier');
const ApiResponse = require('../utils/apiResponse');

/**
 * ERP-Grade Return Processor
 * Handles both Sales Returns (Customer) and Purchase Returns (Supplier)
 */
exports.createReturn = async (req, res, next) => {
  try {
    const { type, supplierId, orderId, items, refundMethod, notes } = req.body;

    if (!items || items.length === 0) return ApiResponse.error(res, 'Items required', 400);

    let totalReturnAmount = 0;

    const returnRecord = await Return.create({
      type,
      supplierId,
      orderId,
      items,
      totalAmount: 0, // Will update below
      refundMethod,
      notes,
      performedBy: req.user._id
    });

    for (const item of items) {
      const inv = await Inventory.findById(item.inventoryId);
      if (!inv) continue;

      const stockBefore = inv.availableStock;
      
      if (type === 'supplier_return') {
        // ── PURCHASE RETURN (Return to Supplier) ──
        // ERP Logic: Deduct from totalStock, update supplier payable
        inv.totalStock -= Number(item.quantity);
        totalReturnAmount += (inv.purchasePrice * item.quantity);
      } else {
        // ── SALES RETURN (Customer Return) ──
        // ERP Logic: Add to returned stock
        inv.returned += Number(item.quantity);
        totalReturnAmount += (item.price * item.quantity);
      }

      await inv.save();
      const updatedInv = await Inventory.findById(item.inventoryId);

      await StockMovement.create({
        inventoryId: inv._id,
        productId: inv.productRef,
        variant: { size: inv.size, color: inv.color },
        type: type === 'supplier_return' ? 'return_supplier' : 'return_customer',
        quantity: type === 'supplier_return' ? -Number(item.quantity) : Number(item.quantity),
        stockBefore,
        stockAfter: updatedInv.availableStock,
        reason: type === 'supplier_return' ? `Supplier Return: ${notes || 'Inventory Cleanup'}` : `Customer Return: ${notes || 'Order #' + (orderId || 'POS')}`,
        performedBy: req.user._id,
        referenceId: returnRecord._id
      });
    }

    // Update the final amount in return record and supplier ledger
    returnRecord.totalAmount = totalReturnAmount;
    await returnRecord.save();

    if (type === 'supplier_return' && supplierId) {
      await Supplier.findByIdAndUpdate(supplierId, {
        $inc: { totalPurchaseAmount: -totalReturnAmount }
      });
    }

    return ApiResponse.created(res, returnRecord, 'Return processed successfully');
  } catch (error) { next(error); }
};

exports.getReturns = async (req, res, next) => {
  try {
    const returns = await Return.find()
      .sort({ createdAt: -1 })
      .populate('performedBy', 'name')
      .populate('supplierId', 'name');
    return ApiResponse.success(res, returns);
  } catch (error) { next(error); }
};
