const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const { getIO } = require('../utils/socket');
const logger = require('../utils/logger');

const requirePositiveQuantity = (qty) => {
  const quantity = Number(qty);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('Stock quantity must be a positive integer');
  }
  return quantity;
};

const getReservationQuantityExpr = (orderId, quantity) => ({
  $expr: {
    $eq: [
      {
        $sum: {
          $map: {
            input: {
              $filter: {
                input: '$reservations',
                as: 'reservation',
                cond: {
                  $eq: ['$$reservation.orderId', new mongoose.Types.ObjectId(orderId.toString())]
                }
              }
            },
            as: 'reservation',
            in: '$$reservation.quantity'
          }
        }
      },
      quantity
    ]
  }
});

/**
 * Magizhchi Enterprise Stock Engine
 * Central authority for all inventory movements.
 * Ensures atomicity, consistency, and audit integrity.
 */
class StockService {
  async _refreshReservationExpiry(inv, session = null) {
    const nextExpiry = inv.reservations.length > 0
      ? inv.reservations.reduce((earliest, reservation) => (
          !earliest || reservation.expiresAt < earliest ? reservation.expiresAt : earliest
        ), null)
      : null;

    inv.reservationExpiresAt = nextExpiry;
    await inv.save(session ? { session } : {});
    return inv;
  }
  
  /**
   * 1. RESERVE STOCK (Online Order Placed)
   * Moves stock from available pool to 'reservedStock'.
   */
   async reserveStock(inventoryId, qty, orderId, session = null) {
    logger.info(`[StockEngine] Reserving ${qty} units for Inv: ${inventoryId} (Order: ${orderId})`);
    
    const expiryMinutes = 20; // Enterprise Default
    const expiresAt = new Date(Date.now() + expiryMinutes * 60000);

    const reservationQty = requirePositiveQuantity(qty);
    
    const inv = await Inventory.findOneAndUpdate(
      { 
        _id: new mongoose.Types.ObjectId(inventoryId.toString()),
        availableStock: { $gte: reservationQty }
      },
      { 
        $inc: { 
          reservedStock: reservationQty,
          availableStock: -reservationQty 
        },
        $push: { 
          reservations: { orderId, quantity: reservationQty, expiresAt } 
        }
      },
      { session, new: true }
    );

    if (!inv) {
      const existing = await Inventory.findById(inventoryId).session(session);
      if (!existing) {
        throw new Error('Inventory item not found');
      } else {
        throw new Error(`Insufficient stock for ${existing.productName || 'product'}. Available: ${existing.availableStock || 0}`);
      }
    }

    await this._refreshReservationExpiry(inv, session);

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    this._emitUpdate(inv);
    return inv;
  }

  /**
   * 2. COMMIT ONLINE SALE (Order Paid/Shipped)
   * Moves stock from 'reservedStock' to 'onlineSold'.
   */
  async commitOnlineSale(inventoryId, qty, orderId, session = null) {
    const quantity = requirePositiveQuantity(qty);
    logger.info(`[StockEngine] Committing Online Sale: ${quantity} units for Inv: ${inventoryId}`);

    const inv = await Inventory.findOneAndUpdate(
      {
        _id: inventoryId,
        reservedStock: { $gte: quantity },
        ...getReservationQuantityExpr(orderId, quantity)
      },
      { 
        $inc: { reservedStock: -quantity, onlineSold: quantity },
        $pull: { reservations: { orderId } }
      },
      { session, new: true }
    );

    if (!inv) throw new Error('Inventory reservation missing during online sale commit');
    await this._refreshReservationExpiry(inv, session);

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    // Audit Log
    await StockMovement.create([{
      inventoryId: inv._id,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'sale_online',
      quantity,
      reason: 'Online Order Committed',
      referenceId: orderId
    }], { session });

    this._emitUpdate(inv);
    return inv;
  }

  /**
   * 3. COMMIT OFFLINE SALE (POS Bill Finalized)
   * Moves stock from 'reserved' to 'offlineSold'.
   */
  async commitOfflineSale(inventoryId, qty, billNumber, billId, userId, session = null) {
    const quantity = requirePositiveQuantity(qty);
    logger.info(`[StockEngine] Committing POS Sale from Reservation: ${quantity} units for Inv: ${inventoryId}`);

    const inv = await Inventory.findOneAndUpdate(
      { _id: inventoryId, reservedStock: { $gte: quantity } },
      { 
        $inc: { reservedStock: -quantity, offlineSold: quantity },
        $pull: { reservations: { orderId: billId } }
      },
      { session, new: true }
    );

    if (!inv) throw new Error('Inventory record lost or reservation missing during POS commit');

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    // Audit Log
    await StockMovement.create([{
      inventoryId: inv._id,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'sale_pos',
      quantity,
      reason: `POS Sale Committed: ${billNumber}`,
      referenceId: billId,
      referenceModel: 'Bill',
      performedBy: userId
    }], { session });

    this._emitUpdate(inv);
    return inv;
  }

  async commitDirectOfflineSale(inventoryId, qty, billNumber, billId, userId, session = null) {
    const quantity = requirePositiveQuantity(qty);
    logger.info(`[StockEngine] Committing Direct POS Sale: ${quantity} units for Inv: ${inventoryId}`);

    const inv = await Inventory.findOneAndUpdate(
      { 
        _id: inventoryId, 
        isDeleted: { $ne: true },
        availableStock: { $gte: quantity }
      },
      { 
        $inc: { availableStock: -quantity, offlineSold: quantity }
      },
      { session, new: true }
    );

    if (!inv) throw new Error('Inventory record lost or not found for POS sale');

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    // Audit Log
    await StockMovement.create([{
      inventoryId: inv._id,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'sale_pos',
      quantity,
      reason: `POS Sale: ${billNumber}`,
      referenceId: billId,
      referenceModel: 'Bill',
      performedBy: userId
    }], { session });

    this._emitUpdate(inv);
    return inv;
  }

  /**
   * 4. RELEASE RESERVATION (Order Cancelled Before Payment)
   * Frees 'reservedStock' back to available pool.
   */
  async releaseReservation(inventoryId, qty, orderId, session = null) {
    const quantity = requirePositiveQuantity(qty);
    logger.info(`[StockEngine] Releasing Reservation: ${quantity} units for Inv: ${inventoryId} (Order: ${orderId})`);

    const inv = await Inventory.findOneAndUpdate(
      {
        _id: inventoryId,
        reservedStock: { $gte: quantity },
        ...getReservationQuantityExpr(orderId, quantity)
      },
      { 
        $inc: { reservedStock: -quantity, availableStock: quantity },
        $pull: { reservations: { orderId } }
      },
      { session, new: true }
    );

    if (!inv) throw new Error('Inventory reservation missing during release');
    await this._refreshReservationExpiry(inv, session);

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    this._emitUpdate(inv);
    return inv;
  }

  /**
   * 5. ROLLBACK SALE (Bill Voided / Order Returned)
   * Reverses sold quantity back to available pool (via totalStock/sold reduction or 'returned' increase)
   */
  async rollbackSale(inventoryId, qty, channel = 'offline', reason = 'Return/Void', userId, session = null) {
    const quantity = requirePositiveQuantity(qty);

    const inv = await Inventory.findOneAndUpdate(
      { _id: inventoryId, [channel === 'online' ? 'onlineSold' : 'offlineSold']: { $gte: quantity } },
      { 
        $inc: { 
          ...(channel === 'online' ? { onlineSold: -quantity } : { offlineSold: -quantity }),
          availableStock: quantity
        } 
      },
      { session, new: true }
    );
    
    if (!inv) throw new Error('Inventory record lost or rollback quantity exceeds sold amount');

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    // Audit Log
    await StockMovement.create([{
      inventoryId: inv._id,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'return_customer',
      quantity,
      reason: `Rollback (${channel}): ${reason}`,
      performedBy: userId
    }], { session });

    this._emitUpdate(inv);
    return inv;
  }

  /**
   * 4. RELEASE EXPIRED RESERVATIONS
   * Background task to cleanup abandoned checkouts.
   */
  async releaseExpiredReservations() {
    const now = new Date();
    const invsWithExpired = await Inventory.find({ 
      reservationExpiresAt: { $lte: now },
      isDeleted: false 
    });

    if (invsWithExpired.length === 0) return { releasedCount: 0 };

    const Order = require('../models/Order');
    const expiredOrderIds = [...new Set(invsWithExpired.flatMap(inv =>
      inv.reservations
        .filter(reservation => reservation.expiresAt <= now && reservation.orderId)
        .map(reservation => reservation.orderId.toString())
    ))];
    const expiringOrders = await Order.find({ _id: { $in: expiredOrderIds } });
    const orderMap = new Map(expiringOrders.map(order => [order._id.toString(), order]));
    const releasableOrderIds = new Set(expiringOrders
      .filter(order => order.orderStatus === 'placed' && order.paymentStatus === 'pending')
      .map(order => order._id.toString()));

    let totalReleased = 0;
    for (const inv of invsWithExpired) {
      const expired = inv.reservations.filter(r => r.expiresAt <= now);
      if (expired.length === 0) continue;

      const qtyToRelease = expired.reduce((sum, reservation) => {
        const orderId = reservation.orderId?.toString();
        const order = orderId ? orderMap.get(orderId) : null;
        return !order || releasableOrderIds.has(orderId) ? sum + reservation.quantity : sum;
      }, 0);
      
      const update = { $pull: { reservations: { expiresAt: { $lte: now } } } };
      if (qtyToRelease > 0) {
        update.$inc = { reservedStock: -qtyToRelease, availableStock: qtyToRelease };
      }
      const updated = await Inventory.findOneAndUpdate(
        { _id: inv._id, ...(qtyToRelease > 0 ? { reservedStock: { $gte: qtyToRelease } } : {}) },
        update,
        { new: true }
      );
      if (!updated) {
        logger.error(`[StockEngine] Could not safely release expired reservations for ${inv._id}`);
        continue;
      }
      await this._refreshReservationExpiry(updated);

      // Sync Profile
      if (updated.productRef) {
         const SyncService = require('./sync.service');
         await SyncService.syncProductStock(updated.productRef);
      }
      
      this._emitUpdate(updated);
      totalReleased += qtyToRelease;

      // 🛡️ ORDER LIFECYCLE SYNC: Cancel the orders associated with these reservations
      logger.info(`[StockEngine] Released ${qtyToRelease} units for ${updated.productName} (${updated.sku})`);
    }

    for (const orderId of releasableOrderIds) {
      const order = orderMap.get(orderId);
      const stillReserved = await Inventory.exists({ 'reservations.orderId': order._id });
      if (stillReserved) {
        logger.warn(`[StockEngine] Order ${order.orderNumber} still has reservations and was not cancelled yet`);
        continue;
      }
      order.orderStatus = 'cancelled';
      order.paymentStatus = 'failed';
      order.cancelReason = 'Stock Reservation Expired';
      order.statusHistory.push({
        status: 'cancelled',
        updatedAt: new Date(),
        note: 'Automatically cancelled by StockEngine: reservation expired.'
      });
      await order.save();
      logger.info(`[StockEngine] Cancelled Order ${order.orderNumber} due to expiry`);
    }

    return { releasedCount: totalReleased };
  }

  /**
   * 5. PAYMENT FAILURE ROLLBACK
   * Manual trigger when payment gateway returns failure.
   */
  async paymentFailureRollback(orderId, session = null) {
    const query = Inventory.find({ 'reservations.orderId': orderId });
    if (session) query.session(session);
    const invs = await query;
    let releasedCount = 0;
    for (const inv of invs) {
      const reservations = inv.reservations.filter(r => r.orderId.toString() === orderId.toString());
      if (reservations.length > 0) {
        const qty = reservations.reduce((sum, reservation) => sum + reservation.quantity, 0);
        const updated = await Inventory.findOneAndUpdate({
          _id: inv._id,
          reservedStock: { $gte: qty },
          ...getReservationQuantityExpr(orderId, qty)
        }, {
          $inc: { reservedStock: -qty, availableStock: qty },
          $pull: { reservations: { orderId } }
        }, { session, new: true });

        if (!updated) {
          throw new Error(`Could not safely roll back reservation for inventory ${inv._id}`);
        }
        await this._refreshReservationExpiry(updated, session);
        if (updated.productRef) {
          const SyncService = require('./sync.service');
          await SyncService.syncProductStock(updated.productRef, session);
        }
        this._emitUpdate(updated);
        releasedCount += qty;
        logger.info(`[StockEngine] Rollback: Released ${qty} units for Order ${orderId}`);
      }
    }
    return releasedCount;
  }

  /**
   * INTERNAL: Sync changes to Product Variants array (FIX H1)
   * Atomic update for both the variant object and the root-level aggregation fields
   */
  async _syncToProduct(productId, size, color, increments, session) {
    const update = { $inc: {} };
    
    // 🛡️ SECURITY: Use precise regex for name/color to avoid partial matches
    const sizeRegex = new RegExp('^' + size.trim() + '$', 'i');
    const colorRegex = new RegExp('^' + (color?.trim() || '') + '$', 'i');

    for (const [field, val] of Object.entries(increments)) {
      if (val === 0) continue;

      // 1. Update the specific variant in the array if it's a supported field
      if (field === 'available' || field === 'totalStock' || field === 'total') {
        const variantField = field === 'available' ? 'available' : 'totalStock';
        update.$inc[`variants.$[elem].${variantField}`] = val;
      }
      
      // 2. Also update the root-level aggregation fields (Parity Shield)
      if (field === 'available' || field === 'availableStock') update.$inc['availableStock'] = val;
      if (field === 'reserved' || field === 'reservedStock') update.$inc['reservedStock'] = val;
      if (field === 'total' || field === 'totalStock') update.$inc['totalStock'] = val;
      if (field === 'onlineSold') update.$inc['salesCount'] = val; // Track total sales
    }

    if (Object.keys(update.$inc).length === 0) return;

    const hasArrayFilter = Object.keys(update.$inc).some(k => k.includes('$[elem]'));

    await Product.findOneAndUpdate(
      { _id: productId },
      update,
      { 
        ...(hasArrayFilter ? {
          arrayFilters: [{ 
            "elem.size": sizeRegex, 
            "elem.color": colorRegex 
          }]
        } : {}),
        session,
        new: true
      }
    );
  }

  /**
   * 6. RECALCULATE PRODUCT STOCK (Data Integrity Guard)
   * Forcefully re-aggregates stock from variants to root.
   * Fixes any drift caused by race conditions or failed syncs.
   */
  async recalculateProductStock(productId, session = null) {
    const product = await (session ? Product.findById(productId).session(session) : Product.findById(productId));
    if (!product) return;

    let total = 0, avail = 0, res = 0;
    product.variants.forEach(v => {
      if (v.isDeleted) return;
      // Recalculate 'available' based on variant counters
      v.available = Math.max(0, (v.totalStock + v.returned) - (v.onlineSold + v.offlineSold + v.reserved + v.damaged));
      total += (v.totalStock || 0);
      avail += (v.available || 0);
      res += (v.reserved || 0);
    });

    product.totalStock = total;
    product.availableStock = avail;
    product.reservedStock = res;
    
    // Sync Status
    if (avail === 0) product.stockStatus = 'out_of_stock';
    else if (avail <= (product.lowStockThreshold || 10)) product.stockStatus = 'low_stock';
    else product.stockStatus = 'in_stock';

    await (session ? product.save({ session }) : product.save());
    logger.info(`[StockEngine] Recalculated stock for ${product.name}: Avail=${avail}`);
  }

  /**
   * INTERNAL: Emit real-time updates via Socket.io
   */
  _emitUpdate(inv) {
    const io = getIO();
    io.emit('STOCK_UPDATED', {
      inventoryId: inv._id,
      productId: inv.productRef,
      availableStock: inv.availableStock,
      reservedStock: inv.reservedStock,
      sku: inv.sku
    });
  }
}

module.exports = new StockService();
