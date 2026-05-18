const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const { getIO } = require('../utils/socket');
const logger = require('../utils/logger');

/**
 * Magizhchi Enterprise Stock Engine
 * Central authority for all inventory movements.
 * Ensures atomicity, consistency, and audit integrity.
 */
class StockService {
  
  /**
   * 1. RESERVE STOCK (Online Order Placed)
   * Moves stock from available pool to 'reservedStock'.
   */
   async reserveStock(inventoryId, qty, orderId, session = null) {
    logger.info(`[StockEngine] Reserving ${qty} units for Inv: ${inventoryId} (Order: ${orderId})`);
    
    const expiryMinutes = 20; // Enterprise Default
    const expiresAt = new Date(Date.now() + expiryMinutes * 60000);

    const reservationQty = Number(qty);
    
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
        },
        $set: { reservationExpiresAt: expiresAt }
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
    logger.info(`[StockEngine] Committing Online Sale: ${qty} units for Inv: ${inventoryId}`);

    const inv = await Inventory.findOneAndUpdate(
      { _id: inventoryId, reservedStock: { $gte: qty } },
      { 
        $inc: { reservedStock: -qty, onlineSold: qty },
        $pull: { reservations: { orderId } }
      },
      { session, new: true }
    );

    if (!inv) throw new Error('Inventory record lost during commit');

    // 🚀 SINGLE SOURCE OF TRUTH: Trigger Unified Sync
    const SyncService = require('./sync.service');
    await SyncService.syncProductStock(inv.productRef, session);

    // Audit Log
    await StockMovement.create([{
      inventoryId: inv._id,
      productId: inv.productRef,
      variant: { size: inv.size, color: inv.color },
      type: 'sale_online',
      quantity: qty,
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
    logger.info(`[StockEngine] Committing POS Sale from Reservation: ${qty} units for Inv: ${inventoryId}`);

    const inv = await Inventory.findOneAndUpdate(
      { _id: inventoryId, reservedStock: { $gte: qty } },
      { 
        $inc: { reservedStock: -qty, offlineSold: qty },
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
      quantity: qty,
      reason: `POS Sale Committed: ${billNumber}`,
      referenceId: billId,
      referenceModel: 'Bill',
      performedBy: userId
    }], { session });

    this._emitUpdate(inv);
    return inv;
  }

  async commitDirectOfflineSale(inventoryId, qty, billNumber, billId, userId, session = null) {
    logger.info(`[StockEngine] Committing Direct POS Sale: ${qty} units for Inv: ${inventoryId}`);

    const inv = await Inventory.findOneAndUpdate(
      { 
        _id: inventoryId, 
        isDeleted: { $ne: true }
      },
      { 
        $inc: { availableStock: -qty, offlineSold: qty }
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
      quantity: qty,
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
    logger.info(`[StockEngine] Releasing Reservation: ${qty} units for Inv: ${inventoryId} (Order: ${orderId})`);

    const inv = await Inventory.findOneAndUpdate(
      { _id: inventoryId, reservedStock: { $gte: qty } },
      { 
        $inc: { reservedStock: -qty, availableStock: qty },
        $pull: { reservations: { orderId } }
      },
      { session, new: true }
    );

    if (!inv) throw new Error('Inventory record lost during release');

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
    const update = channel === 'online' 
      ? { $inc: { onlineSold: -qty } } 
      : { $inc: { offlineSold: -qty } };

    const inv = await Inventory.findOneAndUpdate(
      { _id: inventoryId, [channel === 'online' ? 'onlineSold' : 'offlineSold']: { $gte: qty } },
      { 
        $inc: { 
          ...(channel === 'online' ? { onlineSold: -qty } : { offlineSold: -qty }),
          availableStock: qty 
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
      quantity: qty,
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

    let totalReleased = 0;
    for (const inv of invsWithExpired) {
      const expired = inv.reservations.filter(r => r.expiresAt <= now);
      if (expired.length === 0) continue;

      const qtyToRelease = expired.reduce((sum, r) => sum + r.quantity, 0);
      
      // Update inventory atomically
      const updated = await Inventory.findByIdAndUpdate(inv._id, {
        $inc: { reservedStock: -qtyToRelease, availableStock: qtyToRelease },
        $pull: { reservations: { expiresAt: { $lte: now } } }
      }, { new: true });

      // Recalculate next expiry
      if (updated.reservations.length > 0) {
        updated.reservationExpiresAt = updated.reservations.sort((a,b) => a.expiresAt - b.expiresAt)[0].expiresAt;
      } else {
        updated.reservationExpiresAt = null;
      }
      await updated.save();

      // Sync Profile
      if (updated.productRef) {
         const SyncService = require('./sync.service');
         await SyncService.syncProductStock(updated.productRef);
      }
      
      this._emitUpdate(updated);
      totalReleased += qtyToRelease;

      // 🛡️ ORDER LIFECYCLE SYNC: Cancel the orders associated with these reservations
      for (const resv of expired) {
        if (resv.orderId) {
          const Order = require('../models/Order');
          const order = await Order.findById(resv.orderId);
          if (order && order.orderStatus === 'placed' && order.paymentStatus === 'pending') {
            order.orderStatus = 'cancelled';
            order.cancelReason = 'Stock Reservation Expired';
            order.statusHistory.push({
              status: 'cancelled',
              updatedAt: new Date(),
              note: 'Automatically cancelled by StockEngine: Reservation expired.'
            });
            await order.save();
            logger.info(`[StockEngine] Cancelled Order ${order.orderNumber} due to expiry`);
          }
        }
      }

      totalReleased += qtyToRelease;
      this._emitUpdate(updated);
      logger.info(`[StockEngine] Released ${qtyToRelease} units for ${updated.productName} (${updated.sku})`);
    }

    return { releasedCount: totalReleased };
  }

  /**
   * 5. PAYMENT FAILURE ROLLBACK
   * Manual trigger when payment gateway returns failure.
   */
  async paymentFailureRollback(orderId) {
    const invs = await Inventory.find({ 'reservations.orderId': orderId });
    for (const inv of invs) {
      const reservation = inv.reservations.find(r => r.orderId.toString() === orderId.toString());
      if (reservation) {
        const qty = reservation.quantity;
        const updated = await Inventory.findByIdAndUpdate(inv._id, {
          $inc: { reservedStock: -qty, availableStock: qty },
          $pull: { reservations: { orderId } },
          $set: { reservationExpiresAt: null } // Simplified, next save will fix
        }, { new: true });

        if (updated.productRef) {
          await this._syncToProduct(updated.productRef, updated.size, updated.color, { reserved: -qty });
        }
        this._emitUpdate(updated);
        logger.info(`[StockEngine] Rollback: Released ${qty} units for Order ${orderId}`);
      }
    }
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
