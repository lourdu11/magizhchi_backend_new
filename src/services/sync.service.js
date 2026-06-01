const mongoose = require('mongoose');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const Purchase = require('../models/Purchase');
const Category = require('../models/Category');
const Order = require('../models/Order');
const Bill = require('../models/Bill');
const StockMovement = require('../models/StockMovement');
const Supplier = require('../models/Supplier');
const { getIO } = require('../utils/socket');
const { logAudit } = require('../utils/auditLogger');
const logger = require('../utils/logger');
const slugify = require('slugify');
const { deleteCloudinaryAsset } = require('../utils/cloudinaryHelper');

/**
 * Enterprise-Grade Synchronization Service
 * Handles all atomic operations between Procurement, Inventory, and Product Profiles.
 */
class SyncService {

  /**
   * 0. Permanent Purge (Hard Delete)
   * Surgically removes product and inventory if no history exists.
   */
  async purgeProduct(productId, userId) {
    const io = getIO();
    const product = await Product.findById(productId);
    if (!product) throw new Error('Product not found');

    // 🛡️ DATA INTEGRITY SHIELD: Prevent purging if linked to history
    const hasOrders = await Order.exists({ 'items.productId': productId });
    const hasBills = await Bill.exists({ 'items.productId': productId });
    
    if (hasOrders || hasBills) {
      throw new Error('Cannot purge: Product is linked to historical sales records. Use Archival instead.');
    }

    logger.warn(`[SyncService] PERMANENT PURGE initiated for: ${product.name} by User: ${userId}`);

    // 0. Cloudinary Media Asset Cleanup
    const imageUrls = [];
    if (product.thumbnail) imageUrls.push(product.thumbnail);
    if (product.images && product.images.length > 0) imageUrls.push(...product.images);
    if (product.variants && product.variants.length > 0) {
      product.variants.forEach(v => {
        if (v.images && v.images.length > 0) imageUrls.push(...v.images);
      });
    }

    const linkedInventories = await Inventory.find({ productRef: productId });
    linkedInventories.forEach(inv => {
      if (inv.images && inv.images.length > 0) imageUrls.push(...inv.images);
      if (inv.laptopImage) imageUrls.push(inv.laptopImage);
      if (inv.tabletImage) imageUrls.push(inv.tabletImage);
      if (inv.mobileImage) imageUrls.push(inv.mobileImage);
      if (inv.thumbnail) imageUrls.push(inv.thumbnail);
    });

    const uniqueUrls = [...new Set(imageUrls)].filter(Boolean);
    for (const url of uniqueUrls) {
      deleteCloudinaryAsset(url).catch(err => logger.error(`[Cloudinary Cleanup Error in Purge] ${err.message}`));
    }

    // 1. Delete Inventory Records
    await Inventory.deleteMany({ productRef: productId });

    // 2. Delete Stock Movement History
    await StockMovement.deleteMany({ productId: productId });

    // 3. Delete Product Profile
    await Product.deleteOne({ _id: productId });

    io.emit('PRODUCT_PURGED', { id: productId, name: product.name });
    logAudit({ userId, action: 'PRODUCT_PURGE', module: 'CATALOG', resourceId: productId, details: { name: product.name } });
    
    return { success: true, message: 'Product and all associated inventory permanently purged.' };
  }

  /**
   * 1. Synchronize Profile Changes to Inventory
   * Cascades name, category, brand, and price changes.
   */
  async syncProfileToInventory(productId, updateData, session) {
    const io = getIO();
    const product = await (session ? Product.findById(productId).session(session) : Product.findById(productId));
    if (!product) throw new Error('Product not found');

    logger.info(`[SyncService] Cascading profile changes for: ${product.name}`);

    // Map profile fields to inventory fields
    const invUpdate = {};
    if (updateData.name) invUpdate.productName = updateData.name;
    if (updateData.category) {
      const category = await (session ? Category.findById(updateData.category).session(session) : Category.findById(updateData.category));
      if (category) invUpdate.category = category.name;
    }
    if (updateData.brand) invUpdate.brand = updateData.brand;
    if (updateData.sellingPrice) invUpdate.sellingPrice = updateData.sellingPrice;
    
    // Status flags
    if (updateData.isActive !== undefined) invUpdate.isActive = updateData.isActive;
    if (updateData.isDeleted !== undefined) invUpdate.isDeleted = updateData.isDeleted;

    // Visual Identity Sync (Always sync from the SAVED product to get fallbacks)
    invUpdate.laptopImage = product.laptopImage;
    invUpdate.tabletImage = product.tabletImage;
    invUpdate.mobileImage = product.mobileImage;
    invUpdate.images = product.images;
    invUpdate.thumbnail = product.thumbnail;
    invUpdate.fit = product.fit;
    invUpdate.position = product.position;
    invUpdate.scale = product.scale;

    if (Object.keys(invUpdate).length > 0) {
      await Inventory.updateMany({ productRef: productId }, { $set: invUpdate }, { session });
    }

    // 🚀 ENTERPRISE SYNC: Ensure all variants in the profile have an Inventory record (Parallelized)
    if (product.variants && product.variants.length > 0) {
      // Pre-fetch category name if needed to avoid redundant DB calls in map
      let categoryName = 'Uncategorized';
      if (product.category) {
         const cat = await (session ? Category.findById(product.category).session(session) : Category.findById(product.category));
         if (cat) categoryName = cat.name;
      }

      await Promise.all(product.variants.filter(v => !v.isDeleted).map(async (variant) => {
         // Check if inventory already exists
         const query = {
            productRef: productId,
            size: variant.size,
            color: variant.color
         };
         const existingInv = await Inventory.findOne(query).session(session || null);

         if (!existingInv) {
            logger.info(`[SyncService] Creating missing inventory record for variant: ${variant.size}/${variant.color}`);
            const newInv = new Inventory({
               productRef: productId,
               productName: product.name,
               category: categoryName,
               brand: product.brand,
               size: variant.size,
               color: variant.color,
               sku: variant.sku || `${product.sku}-${variant.size}-${variant.color}`.toUpperCase(),
               barcode: variant.barcode || `MAG${Date.now().toString().slice(-8)}`,
               sellingPrice: variant.price || product.sellingPrice,
               totalStock: Number(variant.totalStock) || Number(variant.available) || 0,
               availableStock: Number(variant.available) || Number(variant.totalStock) || 0,
               isDeleted: false,
               isActive: true,
               laptopImage: variant.thumbnail || product.laptopImage,
               tabletImage: variant.thumbnail || product.tabletImage,
               mobileImage: variant.thumbnail || product.mobileImage,
               images: (variant.images && variant.images.length > 0) ? variant.images : product.images
            });
            await newInv.save({ session });

            const initialQty = Number(variant.totalStock) || Number(variant.available) || 0;
            if (initialQty > 0) {
               await StockMovement.create([{
                  inventoryId: newInv._id,
                  productId: productId,
                  variant: { size: variant.size, color: variant.color },
                  type: 'purchase',
                  quantity: initialQty,
                  reason: 'Initial Variant Allocation (Manual Entry)',
                  stockBefore: 0,
                  stockAfter: initialQty
               }], session ? { session } : {});
            }
         } else {
            // Existing inventory found: check if manual stock level was adjusted in the Variant Manager
            const formQty = Number(variant.available) || Number(variant.totalStock) || 0;
            const currentQty = existingInv.availableStock;
            const diff = formQty - currentQty;
            
            let changed = false;
            if (diff !== 0) {
               logger.info(`[SyncService] Manual stock adjustment detected for variant ${variant.size}/${variant.color}: ${currentQty} -> ${formQty} (diff: ${diff})`);
               existingInv.availableStock = formQty;
               existingInv.totalStock = Math.max(0, existingInv.totalStock + diff);
               changed = true;
               
               await StockMovement.create([{
                  inventoryId: existingInv._id,
                  productId: productId,
                  variant: { size: variant.size, color: variant.color },
                  type: diff > 0 ? 'adjustment_in' : 'adjustment_out',
                  quantity: Math.abs(diff),
                  reason: 'Manual Variant Stock Adjustment (Admin Form)',
                  stockBefore: currentQty,
                  stockAfter: formQty
               }], session ? { session } : {});
            }
            
            const targetPrice = variant.price || product.sellingPrice;
            if (existingInv.sellingPrice !== targetPrice) {
               existingInv.sellingPrice = targetPrice;
               changed = true;
            }

            // Synchronize variant-specific images / thumbnails if they have changed
            const targetImages = (variant.images && variant.images.length > 0) ? variant.images : product.images;
            const targetThumbnail = variant.thumbnail || product.laptopImage;
            
            if (JSON.stringify(existingInv.images) !== JSON.stringify(targetImages)) {
               existingInv.images = targetImages;
               changed = true;
            }
            if (existingInv.laptopImage !== targetThumbnail) {
               existingInv.laptopImage = targetThumbnail;
               existingInv.tabletImage = targetThumbnail;
               existingInv.mobileImage = targetThumbnail;
               changed = true;
            }
            
            if (changed) {
               await existingInv.save({ session });
            }
         }
      }));
    }

    // Trigger UI Refresh
    io.emit('INVENTORY_SYNCED', { productId, changes: Object.keys(invUpdate) });
  }

  /**
   * 2. Synchronize Purchase Bill to Product Profiles & Inventory
   * Runs in a transaction to ensure atomicity.
   */
  async syncPurchaseToCatalog(purchaseId, userId, externalSession = null) {
    const io = getIO();
    let session = externalSession;
    let isManagedSession = false;

    if (!session) {
      try {
        const testSession = await mongoose.startSession();
        try {
           testSession.startTransaction();
           await mongoose.connection.db.collection('inventory').findOne({ _id: new mongoose.Types.ObjectId() }, { session: testSession });
           session = testSession;
           isManagedSession = true;
           logger.info('[SyncService] Managed session started.');
        } catch (transError) {
           logger.warn('[SyncService] Transactions NOT supported. Falling back.');
           await testSession.endSession();
           session = null;
        }
      } catch (e) { session = null; }
    }
    if (!session && process.env.NODE_ENV === 'production') {
      throw new Error('Database transactions are required for procurement sync in production.');
    }
    logger.info(`[SyncService DEBUG] Session exists: ${!!session}, Is in transaction: ${session?.inTransaction ? session.inTransaction() : 'N/A'}`);

    try {
      const purchase = await (session ? Purchase.findById(purchaseId).session(session) : Purchase.findById(purchaseId));
      if (!purchase) throw new Error('Purchase bill not found');
      if (purchase.status !== 'received') throw new Error('Only received bills can be synced to catalog');

      logger.info(`[SyncService] Starting sync for Purchase: ${purchase.purchaseNumber}`);

      for (const item of purchase.items) {
        const productName = (item.productName || '').trim();
        const color = (item.color || '').trim();
        const size = (item.size || '').trim();

        // ── A. DUPLICATE PREVENTION ENGINE ──
        // Prefer explicit productId if provided (direct link from UI), otherwise lookup by name/sku
        let product = null;
        if (item.productId) {
          product = await (session ? Product.findById(item.productId).session(session) : Product.findById(item.productId));
        }
        
        if (!product) {
          product = await this._findExistingProduct(productName, item.sku, item.barcode, session);
        }

        // ── B. AUTO-CREATE / UPDATE MASTER PRODUCT ──
        if (!product) {
          product = await this._createProductFromProcurement(item, purchase, session);
          io.emit('PRODUCT_CREATED', { id: product._id, name: product.name });
        } else {
          // 🚀 LOGICAL RECOVERY: If product name changed while it was archived, update it to the new name
          // This ensures that when a SKU is reused or corrected, the user sees the latest name in the catalog.
          if (product.isDeleted && product.name.toLowerCase() !== productName.toLowerCase()) {
             const oldName = product.name;
             product.name = productName;
             product.slug = slugify(productName, { lower: true }) + '-' + Date.now().toString().slice(-4);
             
             // Cascade name change to all variants in inventory to maintain reference integrity
             const nameUpdateQuery = { productName: oldName, productRef: product._id };
             const nameUpdateData = { $set: { productName: productName } };
             if (session) {
               await Inventory.updateMany(nameUpdateQuery, nameUpdateData, { session });
             } else {
               await Inventory.updateMany(nameUpdateQuery, nameUpdateData);
             }
          }

          // Update existing product metadata
          product.costPrice = item.costPrice;
          if (item.sellingPrice) product.sellingPrice = item.sellingPrice;
          product.isProcurementProduct = true;
          product.isDeleted = false;
          product.isActive = true;
          product.isOnlineProduct = true;
          product.isBillingProduct = true;
          product.isInventoryProduct = true;
          product.deletedAt = undefined;
          product.source = 'procurement';
          product.originType = 'PROCUREMENT';
          
          // 🚀 RESTORE LOGIC: Force restoration and activation upon restocking
          product.isDeleted = false;
          product.isActive = true;
          
          await (session ? product.save({ session }) : product.save());
        }

        // ── C. VARIANT & INVENTORY SYNC ──
        const variantData = await this._syncVariantAndInventory(product, item, purchase, userId, session);
        await this.syncProductStock(product._id, session);
        
        io.emit('STOCK_UPDATED', { 
          productId: product._id, 
          inventoryId: variantData.inventoryId,
          sku: variantData.sku,
          newStock: variantData.newStock 
        });
      }

      if (isManagedSession && session) await session.commitTransaction();
      logger.info(`[SyncService] Successfully synced ${purchase.purchaseNumber}`);
      logAudit({ userId, action: 'PROCUREMENT_SYNC', module: 'INVENTORY', resourceId: purchase._id, details: { number: purchase.purchaseNumber } });
      return { success: true };
    } catch (error) {
      if (isManagedSession && session) await session.abortTransaction();
      logger.error(`[SyncService] Sync Failed for ${purchaseId}: ${error.message}`);
      if (error.stack) logger.error(error.stack);
      io.emit('INVENTORY_SYNC_FAILED', { purchaseId, error: error.message });
      throw error;
    } finally {
      if (isManagedSession && session) session.endSession();
    }
  }

  /**
   * 2. Rollback Purchase (ERP Rollback)
   * Safely reduces stock and handles cascading archival.
   */
  async rollbackPurchase(purchaseId, userId, deleteReason = 'Purchase Bill Cancelled') {
    const io = getIO();
    let session = null;
    try {
      const testSession = await mongoose.startSession();
      try {
        testSession.startTransaction();
        session = testSession;
      } catch (e) {
        await testSession.endSession();
        session = null;
      }
    } catch (e) { session = null; }
    if (!session && process.env.NODE_ENV === 'production') {
      throw new Error('Database transactions are required for procurement rollback in production.');
    }

    try {
      const purchase = await (session ? Purchase.findById(purchaseId).session(session) : Purchase.findById(purchaseId));
      if (!purchase) throw new Error('Purchase not found');
      if (purchase.isDeleted) throw new Error('Purchase already archived');

      logger.info(`[SyncService] Rolling back purchase: ${purchase.purchaseNumber}`);

      for (const item of purchase.items) {
        const inv = await Inventory.findOne({
          $or: [
            { sourcePurchaseId: purchase._id, productName: item.productName, size: item.size, color: item.color },
            { productRef: item.productId, size: item.size, color: item.color }
          ]
        }).session(session || null);

        if (!inv) continue;

        inv.totalStock -= item.quantity;
        // Logic fix: Ensure availableStock doesn't become negative if some stock was already sold
        const qtyToReduce = Math.min(inv.availableStock, item.quantity);
        inv.availableStock -= qtyToReduce;
        
        // 2. Auto-Cleanup / Archival
        if (inv.totalStock <= 0) {
          const hasOtherHistory = await (session 
            ? StockMovement.exists({ inventoryId: inv._id, type: 'purchase', referenceId: { $ne: purchase._id } }).session(session)
            : StockMovement.exists({ inventoryId: inv._id, type: 'purchase', referenceId: { $ne: purchase._id } }));
          
          if (!hasOtherHistory) {
            logger.info(`[SyncService] Variant archived during rollback: ${inv.productName}`);
            inv.isDeleted = true;
          }
        }
        await (session ? inv.save({ session }) : inv.save());

        // 3. Log Movement
        await StockMovement.create([{
          inventoryId: inv._id,
          productId: inv.productRef,
          variant: { size: inv.size, color: inv.color },
          type: 'audit_correction',
          quantity: -item.quantity,
          reason: `Rollback: ${purchase.purchaseNumber}`,
          performedBy: userId,
          referenceId: purchase._id,
          referenceModel: 'Purchase',
          stockBefore: inv.totalStock + item.quantity,
          stockAfter: inv.totalStock
        }], session ? { session } : {});

        // 4. Sync Parent Product Profile
        if (inv.productRef) {
          const product = await (session ? Product.findById(inv.productRef).session(session) : Product.findById(inv.productRef));
          if (product) {
            const vIdx = product.variants.findIndex(v => v.size === inv.size && v.color === inv.color);
            if (vIdx > -1) {
              product.variants[vIdx].totalStock -= item.quantity;
              const vQtyToReduce = Math.min(product.variants[vIdx].available, item.quantity);
              product.variants[vIdx].available -= vQtyToReduce;
              if (inv.isDeleted) product.variants[vIdx].isDeleted = true;
            }
            
            // If all variants archived, archive product
            const activeVariants = product.variants.filter(v => !v.isDeleted);
            if (activeVariants.length === 0 && product.originType === 'PROCUREMENT') {
              product.isDeleted = true;
              product.isActive = false;
              product.archivedAt = new Date();
              product.archivedBy = userId;
              product.deleteReason = 'Last procurement source rolled back';
              io.emit('PRODUCT_ARCHIVED', { id: product._id, name: product.name });
            }
            await (session ? product.save({ session }) : product.save());
          }
        }
      }

      // Finalize Purchase Archival
      if (purchase.supplierId && purchase.status === 'received') {
        const impactAmount = purchase.pricing.manualFinancialImpact !== null && purchase.pricing.manualFinancialImpact !== undefined
          ? Number(purchase.pricing.manualFinancialImpact)
          : Number(purchase.pricing.totalAmount);
        await Supplier.findByIdAndUpdate(purchase.supplierId, {
          $inc: {
            totalPurchaseAmount: -impactAmount,
            totalPaidAmount: -(Number(purchase.paidAmount) || 0)
          },
          $pull: { payments: { referenceId: purchase.purchaseNumber } }
        }, session ? { session } : {});
      }

      purchase.isDeleted = true;
      purchase.deletedAt = new Date();
      purchase.deletedBy = userId;
      purchase.status = 'cancelled';
      await purchase.save({ session });

      if (session) await session.commitTransaction();
      logAudit({ userId, action: 'PROCUREMENT_ROLLBACK', module: 'INVENTORY', resourceId: purchase._id, details: { number: purchase.purchaseNumber } });
      io.emit('PROCUREMENT_ROLLBACK', { purchaseId: purchase._id, number: purchase.purchaseNumber });
      return { success: true };
    } catch (error) {
      if (session) await session.abortTransaction();
      throw error;
    } finally {
      if (session) session.endSession();
    }
  }

  /**
   * 3. Rollback Stock for Update (Surgical Rollback)
   * Resets stock for a purchase bill WITHOUT archiving the bill itself.
   * Used during PUT /admin/purchases/:id
   */
  async rollbackStockForUpdate(purchaseId, userId, session) {
    const io = getIO();
    const purchase = await (session ? Purchase.findById(purchaseId).session(session) : Purchase.findById(purchaseId));
    if (!purchase) throw new Error('Purchase not found');
    if (purchase.isDeleted) throw new Error('Cannot rollback an archived purchase');

    logger.info(`[SyncService] Surgical rollback for update: ${purchase.purchaseNumber}`);

    for (const item of purchase.items) {
      const inv = await Inventory.findOne({
        $or: [
          { sourcePurchaseId: purchase._id, productName: item.productName, size: item.size, color: item.color },
          { productRef: item.productId, size: item.size, color: item.color }
        ]
      }).session(session || null);

      if (!inv) continue;

      const stockBefore = inv.totalStock;
      inv.totalStock -= item.quantity;
      const sQtyToReduce = Math.min(inv.availableStock, item.quantity);
      inv.availableStock -= sQtyToReduce;

      // Auto-Cleanup logic
      if (inv.totalStock <= 0) {
        const historyQuery = { 
          inventoryId: inv._id, 
          type: 'purchase', 
          referenceId: { $ne: purchase._id } 
        };
        const hasOtherHistory = await (session ? StockMovement.exists(historyQuery).session(session) : StockMovement.exists(historyQuery));
        
        if (!hasOtherHistory) {
          inv.isDeleted = true;
          inv.deletedAt = new Date();
        }
      }
      await (session ? inv.save({ session }) : inv.save());

      // Log Movement
      const movement = new StockMovement({
        inventoryId: inv._id,
        productId: inv.productRef,
        variant: { size: inv.size, color: inv.color },
        type: 'audit_correction',
        quantity: -item.quantity,
        reason: `Update-Reset: ${purchase.purchaseNumber}`,
        performedBy: userId,
        referenceId: purchase._id,
        referenceModel: 'Purchase',
        stockBefore,
        stockAfter: inv.totalStock
      });
      await (session ? movement.save({ session }) : movement.save());

      // Sync Master Profile
      if (inv.productRef) {
        const product = await (session ? Product.findById(inv.productRef).session(session) : Product.findById(inv.productRef));
        if (product) {
          const vIdx = product.variants.findIndex(v => v.size === inv.size && v.color === inv.color);
          if (vIdx > -1) {
            product.variants[vIdx].totalStock -= item.quantity;
            if (inv.isDeleted) product.variants[vIdx].isDeleted = true;
          }
          await (session ? product.save({ session }) : product.save());
        }
      }

      io.emit('STOCK_UPDATED', { 
        productId: inv.productRef, 
        inventoryId: inv._id,
        newStock: inv.totalStock 
      });
    }
  }

  /**
   * 3. Archive Product Profile
   * Protected archival with reference checking.
   */
  async archiveProduct(productId, userId, reason = 'Manual Archival') {
    const io = getIO();
    let session = null;
    try {
      const testSession = await mongoose.startSession();
      try {
        testSession.startTransaction();
        session = testSession;
      } catch (e) {
        await testSession.endSession();
        session = null;
      }
    } catch (e) { session = null; }

    try {
      const product = await (session ? Product.findById(productId).session(session) : Product.findById(productId));
      if (!product) throw new Error('Product not found');

      // ── HISTORY PROTECTION ENGINE ──
      const hasOrders = await (session ? Order.exists({ 'items.productId': productId }).session(session) : Order.exists({ 'items.productId': productId }));
      const hasBills = await (session ? Bill.exists({ 'items.productId': productId }).session(session) : Bill.exists({ 'items.productId': productId }));
      
      if (product.totalStock > 0 || hasOrders || hasBills) {
        // Force Soft Delete (Archive)
        product.isDeleted = true;
        product.isActive = false;
        product.archivedAt = new Date();
        product.archivedBy = userId;
        product.deleteReason = reason;
        
        // Propagate to Inventory
        if (session) {
          await Inventory.updateMany({ productRef: productId }, { isDeleted: true, deletedAt: new Date() }, { session });
        } else {
          await Inventory.updateMany({ productRef: productId }, { isDeleted: true, deletedAt: new Date() });
        }

        await product.save({ session });
        if (session) await session.commitTransaction();
        io.emit('PRODUCT_ARCHIVED', { id: productId, name: product.name, mode: 'SOFT_DELETE' });
        return { success: true, mode: 'ARCHIVED' };
      } else {
        // Safe for hard delete if user explicitly wants, but default to archive
        product.isDeleted = true;
        product.archivedAt = new Date();
        await product.save({ session });
        if (session) await session.commitTransaction();
        return { success: true, mode: 'ARCHIVED_CLEAN' };
      }
    } catch (error) {
      if (session) await session.abortTransaction();
      throw error;
    } finally {
      if (session) session.endSession();
    }
  }

  /**
   * 4. System Consistency Auditor
   * Repairs orphaned records and identifies mismatches.
   */
  /**
   * 🎯 SINGLE SOURCE OF TRUTH: Calculate True Stock
   * Core engine used by both APIs and background sync to resolve absolute availability.
   * Handles Standard Products and Virtual Combos.
   */
  async calculateTrueStock(product, session = null) {
     const p = product.toObject ? product.toObject() : product;
     const parentId = p._id?.toString();

     const updatedVariants = [];
     let totalAvail = 0;
     let totalStock = 0;

     try {
        if (p.productNature === 'combo') {
           // Determine whether any slots have valid (non-self) external components
           const hasValidComponents = (p.comboSlots || []).some(slot => {
              const cp = slot.products?.[0];
              if (!cp) return false;
              const cid = cp._id?.toString?.() || cp.id?.toString?.() || (typeof cp === 'string' ? cp : null);
              return cid && cid !== parentId;
           });

           if (!hasValidComponents) {
              // All slots are self-referencing or empty — treat as standalone and read own Inventory
              logger.info(`[SyncService] Combo "${p.name}" has no valid external components. Reading own Inventory.`);
              const ownItems = await (session
                 ? Inventory.find({ productRef: p._id, isDeleted: { $ne: true } }).session(session).lean()
                 : Inventory.find({ productRef: p._id, isDeleted: { $ne: true } }).lean());
              for (const v of p.variants || []) {
                 if (v.isDeleted) continue;
                 const inv = ownItems.find(i => i.size === v.size && i.color?.toLowerCase() === v.color?.toLowerCase());
                 if (inv) {
                    const avail = Math.max(0,
                       (inv.totalStock + (inv.returned || 0))
                       - (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0))
                    );
                    updatedVariants.push({ ...v, available: avail, totalStock: inv.totalStock, qty: avail });
                    totalAvail += avail;
                    totalStock += inv.totalStock;
                 } else {
                    updatedVariants.push({ ...v, available: 0, totalStock: 0, qty: 0 });
                 }
              }
           } else {
              // Normal combo — calculate from component inventories
              for (const v of p.variants || []) {
                 if (v.isDeleted) continue;
                 const componentAvails = [];
                 for (const slot of p.comboSlots || []) {
                    const compProd = slot.products?.[0];
                    if (!compProd) continue;
                    const compId = compProd._id?.toString?.() || compProd.id?.toString?.() || (typeof compProd === 'string' ? compProd : null);
                    if (!compId || compId === parentId) continue; // skip self-refs
                    const invQuery = { productRef: compId, size: v.size, color: v.color, isDeleted: { $ne: true } };
                    const inv = await (session
                       ? Inventory.findOne(invQuery).session(session).lean()
                       : Inventory.findOne(invQuery).lean());
                    if (inv) {
                       const avail = Math.max(0,
                          (inv.totalStock + (inv.returned || 0))
                          - (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0))
                       );
                       componentAvails.push(avail);
                    } else {
                       componentAvails.push(0);
                    }
                 }
                 const realAvail = componentAvails.length > 0 ? Math.min(...componentAvails) : 0;
                 updatedVariants.push({ ...v, available: realAvail, totalStock: realAvail, qty: realAvail });
                 totalAvail += realAvail;
                 totalStock += realAvail;
              }
           }
        } else {
           // Standard product — read directly from own Inventory records
           const inventoryItems = await (session
              ? Inventory.find({ productRef: p._id, isDeleted: { $ne: true } }).session(session).lean()
              : Inventory.find({ productRef: p._id, isDeleted: { $ne: true } }).lean());

           for (const v of p.variants || []) {
              if (v.isDeleted) continue;
              const inv = inventoryItems.find(i =>
                 i.size === v.size && (i.color?.toLowerCase() === v.color?.toLowerCase())
              );
              if (inv) {
                 const avail = Math.max(0,
                    (inv.totalStock + (inv.returned || 0))
                    - (inv.onlineSold + inv.offlineSold + (inv.reservedStock || 0) + (inv.damaged || 0))
                 );
                 updatedVariants.push({ ...v, available: avail, totalStock: inv.totalStock, qty: avail });
                 totalAvail += avail;
                 totalStock += inv.totalStock;
              } else {
                 updatedVariants.push({ ...v, available: 0, totalStock: 0, qty: 0 });
              }
           }
        }
     } catch (err) {
        logger.error(`[SyncService] calculateTrueStock failed for product ${p.name}: ${err.message}`);
        // Return original variants unmodified on error — safe fallback
        return {
           variants: (p.variants || []).filter(v => !v.isDeleted),
           availableStock: p.availableStock || 0,
           totalStock: p.totalStock || 0
        };
     }

     return { variants: updatedVariants, availableStock: totalAvail, totalStock };
  }

  async syncProductStock(productId, session = null, _visitedIds = new Set()) {
    // 🛡️ CIRCULAR DEPENDENCY GUARD: Prevent infinite recursion
    const idStr = productId?.toString();
    if (!idStr || _visitedIds.has(idStr)) {
       logger.warn(`[SyncService] Circular sync detected for product ${idStr}. Stopping.`);
       return null;
    }
    _visitedIds.add(idStr);

    try {
       const p = await (session ? Product.findById(productId).session(session) : Product.findById(productId));
       if (!p) return null;

       const trueStock = await this.calculateTrueStock(p, session);

       p.variants = trueStock.variants;
       p.availableStock = trueStock.availableStock;
       p.totalStock = trueStock.totalStock;

       // NOTE: Inventory collection is always authoritative — never write virtual combo stock back.

       await (session ? p.save({ session }) : p.save());

       // 🚀 RECURSIVE SYNC: propagate to parent combos that use this product as a component
       // Skip self-references — a combo cannot be its own component
       const comboQuery = {
          _id: { $ne: p._id }, // exclude self
          $or: [
             { 'comboSlots.products._id': p._id },
             { 'comboSlots.products.id': idStr },
             { 'comboSlots.products': p._id }
          ]
       };
       const dependentCombos = await (session
          ? Product.find(comboQuery).select('_id').session(session).lean()
          : Product.find(comboQuery).select('_id').lean());

       for (const combo of dependentCombos) {
          await this.syncProductStock(combo._id, session, _visitedIds);
       }

       return p;
    } catch (err) {
       logger.error(`[SyncService] syncProductStock failed for ${idStr}: ${err.message}`);
       return null;
    }
  }

  async runAuditAndRepair() {
    logger.info('[Auditor] Starting Enterprise Consistency Check...');
    const results = { orphanedInventory: 0, duplicateSkus: 0, variantMismatches: 0, fixed: 0 };

    // 1. Repair orphaned Inventory records
    const orphans = await Inventory.find({ productRef: null, isDeleted: false });
    for (const inv of orphans) {
      const parent = await Product.findOne({ name: inv.productName, isDeleted: false });
      if (parent) {
        inv.productRef = parent._id;
        await inv.save();
        results.fixed++;
      } else {
        results.orphanedInventory++;
      }
    }

    // 2. Sync isDeleted status (Archival Consistency Shield)
    const deletedProducts = await Product.find({ isDeleted: true }).select('_id');
    const deletedIds = deletedProducts.map(p => p._id);
    
    if (deletedIds.length > 0) {
      const repairResult = await Inventory.updateMany(
        { productRef: { $in: deletedIds }, isDeleted: false },
        { $set: { isDeleted: true, deletedAt: new Date() } }
      );
      results.fixed += repairResult.modifiedCount;
    }

    // 3. Global Stock Parity Sync (The "Logical Fix")
    // Aligns Product document variants and aggregate stock fields with real Inventory records
    const products = await Product.find({ isDeleted: false });
    for (const p of products) {
      try {
        await this.syncProductStock(p._id);
        results.fixed++;
      } catch (err) {
        logger.error(`[Auditor] Failed to sync product ${p.name}: ${err.message}`);
      }
    }

    // 5. Duplicate SKU Check
    const skuGroups = await Inventory.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: "$sku", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);
    results.duplicateSkus = skuGroups.length;

    logger.info(`[Auditor] Audit Complete. Fixed: ${results.fixed}, Orphans: ${results.orphanedInventory}, Duplicates: ${results.duplicateSkus}`);
    return results;
  }

  // ── INTERNAL HELPER METHODS ──

  async _findExistingProduct(name, sku, barcode, session) {
    const query = { $or: [] };
    if (sku) query.$or.push({ sku: sku.toUpperCase() });
    if (barcode) query.$or.push({ barcode });
    
    // Robust exact match with regex escaping to handle special characters (e.g. "Cotton (XL)")
    const escapedName = (name || '').replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    query.$or.push({ name: { $regex: new RegExp('^' + escapedName + '$', 'i') } });
    
    return session ? await Product.findOne(query).session(session) : await Product.findOne(query);
  }

  async _createProductFromProcurement(item, purchase, session) {
    const catName = (item.category || 'Uncategorized').trim();
    const escapedCatName = catName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const catQuery = { name: { $regex: new RegExp('^' + escapedCatName + '$', 'i') } };
    let category = await (session ? Category.findOne(catQuery).session(session) : Category.findOne(catQuery));
    
    if (!category) {
      category = new Category({ 
        name: catName,
        slug: slugify(catName, { lower: true })
      });
      await (session ? category.save({ session }) : category.save());
    }

    const sku = item.sku || `PRD-${item.productName.slice(0,3).toUpperCase()}-${Date.now().toString().slice(-4)}`;
    
    const productData = {
      name: item.productName,
      slug: slugify(item.productName, { lower: true }) + '-' + Date.now().toString().slice(-4),
      sku: sku.toUpperCase(),
      category: category._id,
      costPrice: item.costPrice,
      sellingPrice: item.sellingPrice || item.costPrice * 1.5,
      source: 'procurement',
      originType: 'PROCUREMENT',
      isProcurementProduct: true,
      isActive: true,
      isOnlineProduct: true,
      isBillingProduct: true,
      isInventoryProduct: true,
      images: item.images?.length > 0 ? [item.images[0]] : [],
      laptopImage: item.laptopImage || (item.images?.length > 0 ? item.images[0] : ''),
      tabletImage: item.tabletImage || (item.images?.length > 0 ? item.images[0] : ''),
      mobileImage: item.mobileImage || (item.images?.length > 0 ? item.images[0] : '')
    };
    
    const newProduct = new Product(productData);
    await (session ? newProduct.save({ session }) : newProduct.save());
    return newProduct;
  }

  async _syncVariantAndInventory(product, item, purchase, userId, session) {
    const barcode = item.barcode || `MAG${Date.now().toString().slice(-8)}${Math.floor(Math.random()*100).toString().padStart(2, '0')}`;
    const sku = item.sku || `${product.name.slice(0,3)}-${item.color?.slice(0,3)}-${item.size}`.toUpperCase().replace(/\s+/g, '');
    const invQuery = { productName: product.name, size: item.size, color: item.color };
    const existingInventory = await (session
      ? Inventory.findOne(invQuery).session(session)
      : Inventory.findOne(invQuery));
    let quantityToApply = Number(item.quantity) || 0;
    if (existingInventory) {
      const movementAggregate = StockMovement.aggregate([
        {
          $match: {
            inventoryId: existingInventory._id,
            referenceId: purchase._id,
            type: { $in: ['purchase', 'audit_correction'] }
          }
        },
        { $group: { _id: null, quantity: { $sum: '$quantity' } } }
      ]);
      if (session) movementAggregate.session(session);
      const [movementBalance] = await movementAggregate;
      quantityToApply = Math.max(0, quantityToApply - (Number(movementBalance?.quantity) || 0));
    }

    // 1. Update Product Variant Array (Atomic Upsert Pattern)
    const existingVariant = product.variants.find(v => v.size === item.size && v.color === item.color);
    
    if (existingVariant) {
      const variantUpdate = {
        $inc: { "variants.$[elem].totalStock": quantityToApply },
        $set: { "variants.$[elem].isDeleted": false }
      };
      await (session 
        ? Product.findOneAndUpdate({ _id: product._id }, variantUpdate, { 
            arrayFilters: [{ "elem.size": item.size, "elem.color": item.color }],
            session,
            new: true 
          })
        : Product.findOneAndUpdate({ _id: product._id }, variantUpdate, { 
            arrayFilters: [{ "elem.size": item.size, "elem.color": item.color }],
            new: true 
          }));
    } else {
      const newVariant = {
        size: item.size,
        color: item.color,
        sku,
        barcode,
        totalStock: quantityToApply,
        available: quantityToApply,
        price: item.sellingPrice || product.sellingPrice
      };
      await (session 
        ? Product.findOneAndUpdate({ _id: product._id }, { $push: { variants: newVariant } }, { session, new: true })
        : Product.findOneAndUpdate({ _id: product._id }, { $push: { variants: newVariant } }, { new: true }));
    }

    // 2. Update/Create Inventory (Traceable Source Mapping)
    const invUpdate = {
        $inc: { 
          totalStock: quantityToApply,
          availableStock: quantityToApply
        },
        $set: {
          productRef: product._id,
          sourcePurchaseId: purchase._id,
          sourceBillId: purchase.billNumber,
          sourceVendorId: purchase.supplierId,
          purchasePrice: item.costPrice,
          sellingPrice: item.sellingPrice || product.sellingPrice,
          isDeleted: false,
          laptopImage: product.laptopImage,
          tabletImage: product.tabletImage,
          mobileImage: product.mobileImage,
          images: product.images,
          thumbnail: product.thumbnail,
          fit: product.fit,
          position: product.position,
          scale: product.scale
        },
        $setOnInsert: { sku, barcode, onlineEnabled: true, offlineEnabled: true }
    };
    
    const inv = await (session 
      ? Inventory.findOneAndUpdate(invQuery, invUpdate, { upsert: true, new: true, session })
      : Inventory.findOneAndUpdate(invQuery, invUpdate, { upsert: true, new: true }));

    // 3. Log Movement
    if (quantityToApply > 0) {
      const movement = new StockMovement({
        inventoryId: inv._id,
        productId: product._id,
        variant: { size: item.size, color: item.color },
        type: 'purchase',
        quantity: quantityToApply,
        reason: `Procurement Bill: ${purchase.purchaseNumber}`,
        performedBy: userId,
        referenceId: purchase._id,
        stockBefore: inv.totalStock - quantityToApply,
        stockAfter: inv.totalStock
      });

      await (session ? movement.save({ session }) : movement.save());
    }

    return { inventoryId: inv._id, sku, newStock: inv.totalStock };
  }

  /**
   * 4. Enterprise Self-Healing Reconciliation Engine (Audit Mode)
   * Scans entire system for stock mismatches, orphaned records, and data drift.
   */
  async runGlobalAudit() {
    const results = {
      fixed: 0,
      orphanedInventory: 0,
      duplicateSkus: 0,
      mismatchedStock: 0,
      timestamp: new Date()
    };

    logger.info('[SyncService] Starting Global System Audit...');

    // 1. Detect Orphaned Inventory (Reference Integrity Check)
    const allInventory = await Inventory.find({ isDeleted: false });
    for (const inv of allInventory) {
       if (!inv.productRef) {
          logger.warn(`[Auditor] Orphaned Inventory found: ${inv.productName} (${inv.sku}). Archiving.`);
          inv.isDeleted = true;
          inv.deletedAt = new Date();
          await inv.save();
          results.orphanedInventory++;
          results.fixed++;
          continue;
       }
       const parent = await Product.findById(inv.productRef);
       if (!parent || parent.isDeleted) {
          logger.warn(`[Auditor] Inventory ref deleted product: ${inv.productName}. Archiving.`);
          inv.isDeleted = true;
          inv.deletedAt = new Date();
          await inv.save();
          results.orphanedInventory++;
          results.fixed++;
       }
    }

    // 2. Global Stock Parity Sync (The "Logical Fix")
    const products = await Product.find({ isDeleted: false });
    for (const p of products) {
      try {
        const previousStock = p.availableStock;
        await this.syncProductStock(p._id);
        const updated = await Product.findById(p._id);
        if (updated.availableStock !== previousStock) {
           results.mismatchedStock++;
           results.fixed++;
        }
      } catch (err) {
        logger.error(`[Auditor] Failed to sync product ${p.name}: ${err.message}`);
      }
    }

    // 3. Duplicate SKU Check
    const skuGroups = await Inventory.aggregate([
      { $match: { isDeleted: false } },
      { $group: { _id: "$sku", count: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]);
    results.duplicateSkus = skuGroups.length;

    logger.info(`[Auditor] Audit Complete. Fixed: ${results.fixed}, Mismatches: ${results.mismatchedStock}, Orphans: ${results.orphanedInventory}`);
    return results;
  }
}

module.exports = new SyncService();
