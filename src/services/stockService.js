const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const logger = require('../utils/logger');

/**
 * MAGIZHCHI CONTROL CONSOLE — Unified Stock Service
 * Establishing a single source of truth for all inventory data.
 */

async function getProductLiveStock(productId) {
  const result = await Inventory.aggregate([
    { $match: { productRef: new mongoose.Types.ObjectId(productId), isDeleted: { $ne: true } } },
    {
      $group: {
        _id: '$productRef',
        totalStock: { $sum: '$totalStock' },
        availableStock: { $sum: '$availableStock' },
        reservedStock: { $sum: '$reservedStock' },
        onlineSold: { $sum: '$onlineSold' },
        offlineSold: { $sum: '$offlineSold' },
        variantCount: { $sum: 1 }
      }
    }
  ]);
  return result[0] || { totalStock: 0, availableStock: 0, reservedStock: 0, onlineSold: 0, offlineSold: 0, variantCount: 0 };
}

async function getVariantLiveStock(productId, size, color) {
  const inventory = await Inventory.findOne({
    productRef: productId,
    size,
    color: color || '',
    isDeleted: { $ne: true }
  }).select('availableStock reservedStock onlineSold offlineSold totalStock');
  return inventory || { availableStock: 0, reservedStock: 0, onlineSold: 0, offlineSold: 0, totalStock: 0 };
}

async function syncProductStockSummary(productId, session = null) {
  const syncService = require('./sync.service');
  const p = await syncService.syncProductStock(productId, session);
  if (p) {
    return {
      totalStock: p.totalStock,
      availableStock: p.availableStock,
      reservedStock: p.reservedStock,
      onlineSold: p.onlineSold || 0,
      offlineSold: p.offlineSold || 0
    };
  }

  // Fallback to legacy behaviour if sync fails or product is not found
  const product = await Product.findById(productId).select('productNature');
  let stock;
  if (product?.productNature === 'combo') {
    const comboStock = await getComboProductStock(productId);
    stock = {
      totalStock: comboStock.availableStock,
      availableStock: comboStock.availableStock,
      reservedStock: 0,
      onlineSold: 0,
      offlineSold: 0
    };
  } else {
    stock = await getProductLiveStock(productId);
  }

  await Product.findByIdAndUpdate(
    productId,
    {
      $set: {
        totalStock: stock.totalStock,
        availableStock: stock.availableStock,
        reservedStock: stock.reservedStock,
        salesCount: (stock.onlineSold || 0) + (stock.offlineSold || 0)
      }
    },
    { session }
  );
  return stock;
}

/**
 * IMPLEMENT FIX 2 — Combo Product Stock Derivation
 */
async function getComboProductStock(comboProductId) {
  const comboProduct = await Product.findById(comboProductId)
    .select('productNature comboSlots name discountedPrice sellingPrice')
    .populate('comboSlots.products.productRef', '_id name');

  if (comboProduct?.productNature !== 'combo' || !comboProduct.comboSlots?.length) {
    return { availableStock: 0, variantStockMap: {} };
  }

  // Fetch inventory for all component products in all slots
  const slotStocks = await Promise.all(
    comboProduct.comboSlots.map(async (slot) => {
      const productIds = slot.products.map(p => p.productRef?._id || p.productRef || p._id || p);
      return Inventory.find({ productRef: { $in: productIds }, isDeleted: { $ne: true } })
        .select('size color availableStock sku productRef')
        .lean();
    })
  );

  const variantStockMap = {};
  
  // Slot 1 is the primary driver for size/color combinations
  const slot1Variants = slotStocks[0] || [];

  for (const variant of slot1Variants) {
    const size = variant.size;
    const color = variant.color;
    const key = `${size}-${color}`;

    // Check if other slots have matching sizes with stock
    const comboSelections = [{ inventoryId: variant._id, productName: comboProduct.comboSlots[0]?.name }];
    const otherSlotsHaveStock = slotStocks.slice(1).every((slotInventory, idx) => {
      const match = slotInventory.find(v => v.size === size);
      if (match) {
        comboSelections.push({ inventoryId: match._id, productName: comboProduct.comboSlots[idx + 1]?.name });
      }
      return match && match.availableStock > 0;
    });

    if (otherSlotsHaveStock) {
      const minStockRaw = slotStocks.slice(1).reduce((min, slotInventory) => {
        const match = slotInventory.find(v => v.size === size);
        return Math.min(min, match ? match.availableStock : 0);
      }, variant.availableStock);

      // Apply explicit allocation limit from syncedVariants if the user defined them
      let explicitQtyConstraint = Infinity;
      let hasAnySyncedVariants = false;
      comboProduct.comboSlots.forEach(slot => {
        if (slot.products && slot.products[0] && slot.products[0].syncedVariants?.length > 0) {
          hasAnySyncedVariants = true;
          const synced = slot.products[0].syncedVariants.find(v => 
            v.size === size && (v.color || '').toLowerCase() === (color || '').toLowerCase()
          );
          if (synced && typeof synced.qty === 'number') {
             explicitQtyConstraint = Math.min(explicitQtyConstraint, synced.qty);
          }
        }
      });

      // If the user explicitly defined synced variants, but this size/color isn't mapped, SKIP IT
      if (hasAnySyncedVariants && explicitQtyConstraint === Infinity) {
        continue;
      }

      const minStock = explicitQtyConstraint !== Infinity ? Math.min(minStockRaw, explicitQtyConstraint) : minStockRaw;

      variantStockMap[key] = {
        productId: comboProductId,
        productName: comboProduct.name,
        size,
        color,
        sku: variant.sku,
        availableStock: minStock,
        sellingPrice: comboProduct.discountedPrice || comboProduct.sellingPrice,
        comboSelections
      };
    }
  }

  const totalAvailable = Object.values(variantStockMap).reduce((sum, v) => sum + v.availableStock, 0);
  return { availableStock: totalAvailable, variantStockMap };
}

module.exports = {
  getProductLiveStock,
  getVariantLiveStock,
  syncProductStockSummary,
  getComboProductStock
};
