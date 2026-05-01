const Bill = require('../models/Bill');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const User = require('../models/User');
const StockMovement = require('../models/StockMovement');
const ApiResponse = require('../utils/apiResponse');

// ── POST /bills ───────────────────────────────────────────────────────────────
exports.createBill = async (req, res, next) => {
  try {
    let { 
      items, customerDetails, paymentMethod, paymentDetails, 
      discount = 0, discountType = 'flat', roundOff = 0,
      taxType = 'regular', shopInfo, notes,
      billNumber: manualBillNumber,
      billDate: manualBillDate
    } = req.body;

    if (!items || items.length === 0) return ApiResponse.error(res, 'Bill must have at least one item', 400);

    const billItems = [];
    let subtotal = 0;

    for (const item of items) {
      // Find product by ID or Name (for manual entries)
      let product;
      if (item.productId) {
        product = await Product.findById(item.productId);
      } else if (item.productName) {
        product = await Product.findOne({ name: new RegExp('^' + item.productName.trim() + '$', 'i') });
      }

      const itemSize  = item.variant?.size  || item.size  || 'Free Size';
      const itemColor = item.variant?.color || item.color || 'Default';

      // Find inventory
      let invItem;
      if (product) {
        invItem = await Inventory.findOne({
          productName: product.name, size: itemSize, color: itemColor
        });
      }

      const price = Number(item.price) || invItem?.sellingPrice || product?.sellingPrice || 0;
      const itemTotal = price * item.quantity;
      
      // Calculate GST based on taxType
      let taxableValue = itemTotal;
      let gstAmt = 0;
      
      if (taxType === 'regular' && product) {
        const gstRate = (invItem?.gstPercentage || product.gstPercentage || 5) / 100;
        taxableValue = parseFloat((itemTotal / (1 + gstRate)).toFixed(2));
        gstAmt = parseFloat((itemTotal - taxableValue).toFixed(2));
      } else if (taxType === 'composition') {
        // Composition usually means price includes tax but not shown separately
        taxableValue = itemTotal;
        gstAmt = 0;
      }

      const halfGst = parseFloat((gstAmt / 2).toFixed(2));

      billItems.push({
        productId: product?._id,
        productName: item.productName || product?.name || 'Generic Item',
        sku: item.sku || invItem?.sku || product?.sku || 'MANUAL',
        hsnCode: item.hsnCode || product?.hsnCode || '6205',
        inventoryId: invItem?._id,
        variant: { size: itemSize, color: itemColor },
        quantity: item.quantity,
        price,
        taxableValue,
        cgst: halfGst,
        sgst: halfGst,
        total: itemTotal,
      });

      // Deduct stock only if inventory exists and it's not a historical manual entry (optional check)
      if (invItem && !manualBillDate) {
        await Inventory.findByIdAndUpdate(invItem._id, { $inc: { offlineSold: item.quantity } });
        
        // Low stock alert
        const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
        checkAndAlertLowStock(invItem).catch(() => {});

        StockMovement.create({
          productId: product?._id, inventoryId: invItem._id,
          variant: { size: itemSize, color: itemColor },
          type: 'sale', quantity: item.quantity,
          reason: 'Manual/POS Sale', performedBy: req.user._id,
        }).catch(() => {});
      }

      subtotal += itemTotal;
    }

    // Pricing calculation
    let discAmt = Number(discount);
    if (discountType === 'percentage') {
       discAmt = (subtotal * discAmt) / 100;
    } else if (discountType === 'offer') {
       // Offer usually means subtotal - discount = 0 if it's a 100% discount
       discAmt = Number(discount) > 0 ? Number(discount) : subtotal;
    }

    const totalAmount = subtotal - discAmt + Number(roundOff);
    const gstAmount = billItems.reduce((sum, i) => sum + (i.cgst + i.sgst), 0);

    // Bill Number generation
    let billNumber = manualBillNumber;
    if (!billNumber) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const countToday = await Bill.countDocuments({ createdAt: { $gte: todayStart, $lte: todayEnd } });
      const sequence   = (countToday + 1).toString().padStart(3, '0');
      const dateStr    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      billNumber = `BILL-${dateStr}-MAG${sequence}`;
    }

    // Commission
    const staff = await User.findById(req.user._id);
    const commissionAmount = (totalAmount * (staff?.commissionRate || 0)) / 100;

    const bill = await Bill.create({
      billNumber,
      billDate: manualBillDate || new Date(),
      staffId: req.user._id,
      commissionAmount,
      customerDetails,
      items: billItems,
      taxType,
      pricing: { 
        subtotal, 
        discount: discAmt, 
        discountType,
        gstAmount, 
        roundOff: Number(roundOff),
        totalAmount 
      },
      paymentMethod,
      paymentDetails: paymentDetails || {},
      shopInfo,
      notes,
    });

    await bill.populate('items.productId', 'name images sku');
    return ApiResponse.created(res, { bill }, 'Bill saved successfully');
  } catch (error) { next(error); }
};

// ── GET /bills ────────────────────────────────────────────────────────────────
exports.getBills = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, date, search } = req.query;
    const query = {};
    if (req.user.role === 'staff') query.staffId = req.user._id;
    if (date) {
      const start = new Date(date); start.setHours(0, 0, 0, 0);
      const end   = new Date(date); end.setHours(23, 59, 59, 999);
      query.createdAt = { $gte: start, $lte: end };
    }
    if (search) {
      query.$or = [
        { billNumber:              { $regex: search, $options: 'i' } },
        { 'customerDetails.name':  { $regex: search, $options: 'i' } },
        { 'customerDetails.phone': { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [bills, total] = await Promise.all([
      Bill.find(query)
        .populate('staffId', 'name')
        .populate('items.productId', 'name images sku')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Bill.countDocuments(query),
    ]);
    return ApiResponse.paginated(res, bills, { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / Number(limit)) });
  } catch (error) { next(error); }
};

// ── GET /bills/:id ────────────────────────────────────────────────────────────
exports.getBill = async (req, res, next) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role === 'staff') query.staffId = req.user._id;
    const bill = await Bill.findOne(query)
      .populate('staffId', 'name')
      .populate('items.productId', 'name images sku');
    if (!bill) return ApiResponse.notFound(res, 'Bill not found');
    return ApiResponse.success(res, { bill });
  } catch (error) { next(error); }
};

// ── GET /bills/daily-report ───────────────────────────────────────────────────
exports.getDailyReport = async (req, res, next) => {
  try {
    const date  = req.query.date ? new Date(req.query.date) : new Date();
    const start = new Date(date); start.setHours(0, 0, 0, 0);
    const end   = new Date(date); end.setHours(23, 59, 59, 999);
    const query = { createdAt: { $gte: start, $lte: end } };
    if (req.user.role === 'staff') query.staffId = req.user._id;

    const [bills, summary] = await Promise.all([
      Bill.find(query).sort({ createdAt: 1 }),
      Bill.aggregate([
        { $match: query },
        { $group: {
          _id: null,
          totalRevenue: { $sum: '$pricing.totalAmount' },
          totalBills:   { $sum: 1 },
          cashTotal:    { $sum: '$paymentDetails.cashAmount' },
          upiTotal:     { $sum: '$paymentDetails.upiAmount' },
          cardTotal:    { $sum: '$paymentDetails.cardAmount' },
        }},
      ]),
    ]);
    return ApiResponse.success(res, { bills, summary: summary[0] || {}, date: date.toDateString() });
  } catch (error) { next(error); }
};

// ── GET /bills/customer/:phone ─────────────────────────────────────────────────
exports.lookupCustomer = async (req, res, next) => {
  try {
    const user = await User.findOne({ phone: req.params.phone }).select('name email phone');
    if (!user) return ApiResponse.notFound(res, 'Customer not found');
    return ApiResponse.success(res, { customer: user });
  } catch (error) { next(error); }
};

// ── DELETE /bills/:id ─────────────────────────────────────────────────────────
exports.deleteBill = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return ApiResponse.notFound(res, 'Bill not found');

    // Reverse stock in Inventory (NOT legacy Product.variants)
    for (const item of bill.items) {
      if (item.inventoryId) {
        await Inventory.findByIdAndUpdate(item.inventoryId, { $inc: { offlineSold: -item.quantity } });
      }
      StockMovement.create({
        productId: item.productId, inventoryId: item.inventoryId,
        variant: item.variant, type: 'return', quantity: item.quantity,
        reason: `Bill Deleted: ${bill.billNumber}`, performedBy: req.user._id,
      }).catch(() => {});
    }

    await Bill.findByIdAndDelete(req.params.id);
    return ApiResponse.success(res, null, 'Bill deleted and stock restored');
  } catch (error) { next(error); }
};
