const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Bill = require('../models/Bill');
const Settings = require('../models/Settings');
const ApiResponse = require('../utils/apiResponse');
const Inventory = require('../models/Inventory');
const Purchase = require('../models/Purchase');

// Simple in-memory cache for heavy stats
let dashboardCache = { data: null, lastUpdated: 0 };
const CACHE_TTL = 60 * 1000; // 1 minute

const lowStockPipeline = [
  { $addFields: {
      availableStock: {
        $max: [0, { $subtract: [
          { $add: ['$totalStock', '$returned'] },
          { $add: ['$onlineSold', '$offlineSold', { $ifNull: ['$reservedStock', 0] }, '$damaged'] }
        ]}]
      }
  }},
  { $match: { $expr: { $lte: ['$availableStock', { $ifNull: ['$lowStockThreshold', 5] }] } } },
  { $sort: { availableStock: 1 } },
];

exports.getDashboardStats = async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [
      revenueStats,
      pendingOrders, deliveredOrders,
      registeredUsers, uniqueGuests,
      lowStockInventory,
      supplierStats,
      wastageStats
    ] = await Promise.all([
      // 1. Revenue & Cost Aggregation
      Order.aggregate([
        { $match: { orderStatus: { $nin: ['cancelled', 'returned'] } } },
        { $unwind: '$items' },
        { $lookup: { from: 'inventories', localField: 'items.inventoryId', foreignField: '_id', as: 'inv' } },
        { $unwind: '$inv' },
        { $group: {
            _id: null,
            todayRevenue: { $sum: { $cond: [{ $gte: ['$createdAt', today] }, '$items.total', 0] } },
            todayCost: { $sum: { $cond: [{ $gte: ['$createdAt', today] }, { $multiply: ['$inv.purchasePrice', '$items.quantity'] }, 0] } },
            monthRevenue: { $sum: { $cond: [{ $gte: ['$createdAt', thisMonth] }, '$items.total', 0] } },
        }},
        { $unionWith: {
            coll: 'bills',
            pipeline: [
              { $unwind: '$items' },
              { $lookup: { from: 'inventories', localField: 'items.inventoryId', foreignField: '_id', as: 'inv' } },
              { $unwind: '$inv' },
              { $group: {
                  _id: null,
                  todayRevenue: { $sum: { $cond: [{ $gte: ['$createdAt', today] }, '$items.total', 0] } },
                  todayCost: { $sum: { $cond: [{ $gte: ['$createdAt', today] }, { $multiply: ['$inv.purchasePrice', '$items.quantity'] }, 0] } },
                  monthRevenue: { $sum: { $cond: [{ $gte: ['$createdAt', thisMonth] }, '$items.total', 0] } },
              }}
            ]
        }},
        { $group: {
            _id: null,
            todayRevenue: { $sum: '$todayRevenue' },
            todayCost: { $sum: '$todayCost' },
            monthRevenue: { $sum: '$monthRevenue' }
        }}
      ]),
      Order.countDocuments({ orderStatus: { $in: ['placed', 'confirmed', 'processing'] } }),
      Order.countDocuments({ orderStatus: 'delivered' }),
      User.countDocuments({ role: 'user' }),
      Order.distinct('shippingAddress.phone', { isGuestOrder: true }),
      // 2. Low Stock Inventory (Optimized to use real field)
      Inventory.find({ 
        $expr: { $lte: ['$availableStock', '$lowStockThreshold'] } 
      }).limit(10).lean(),
      // 3. Supplier Payables
      require('../models/Supplier').aggregate([
        { $group: {
            _id: null,
            totalPayables: { $sum: { $subtract: [{ $add: ['$openingBalance', '$totalPurchaseAmount'] }, '$totalPaidAmount'] } }
        }}
      ]),
      // 4. Wastage
      require('../models/Wastage').aggregate([
        { $match: { createdAt: { $gte: today } } },
        { $group: { _id: null, todayLoss: { $sum: '$lossAmount' } } }
      ])
    ]);

    const stats = revenueStats[0] || { todayRevenue: 0, todayCost: 0, monthRevenue: 0 };
    const payables = supplierStats[0]?.totalPayables || 0;
    const wastageLoss = wastageStats[0]?.todayLoss || 0;

    const finalData = {
      revenue: {
        today: stats.todayRevenue,
        month: stats.monthRevenue,
        todayProfit: stats.todayRevenue - stats.todayCost,
      },
      erp: {
        totalPayables: payables,
        todayWastage: wastageLoss,
      },
      orders: {
        pending: pendingOrders,
        delivered: deliveredOrders,
      },
      users: (registeredUsers || 0) + (uniqueGuests?.length || 0),
      lowStockProducts: lowStockInventory,
    };

    // Update Cache
    dashboardCache = { data: finalData, lastUpdated: Date.now() };

    return ApiResponse.success(res, finalData);
  } catch (error) { next(error); }
};

let analyticsCache = {}; // Map of period+year -> data
const ANALYTICS_TTL = 5 * 60 * 1000; // 5 minutes

exports.getSalesAnalytics = async (req, res, next) => {
  try {
    const { period = 'monthly', year = new Date().getFullYear() } = req.query;
    const cacheKey = `${period}-${year}`;

    if (analyticsCache[cacheKey] && (Date.now() - analyticsCache[cacheKey].lastUpdated < ANALYTICS_TTL)) {
      return ApiResponse.success(res, analyticsCache[cacheKey].data);
    }

    let groupBy, match, prevMatch;
    const now = new Date();

    if (period === 'daily') {
      const startOf = new Date(); startOf.setDate(startOf.getDate() - 30);
      const prevStartOf = new Date(startOf); prevStartOf.setDate(prevStartOf.getDate() - 30);
      match = { createdAt: { $gte: startOf } };
      prevMatch = { createdAt: { $gte: prevStartOf, $lt: startOf } };
      groupBy = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    } else if (period === 'monthly') {
      match = { createdAt: { $gte: new Date(year, 0, 1) } };
      prevMatch = { createdAt: { $gte: new Date(year - 1, 0, 1), $lt: new Date(year, 0, 1) } };
      groupBy = { $dateToString: { format: '%Y-%m', date: '$createdAt' } };
    } else {
      match = {};
      prevMatch = { createdAt: { $lt: new Date(year, 0, 1) } }; // Generic prev
      groupBy = { $dateToString: { format: '%Y', date: '$createdAt' } };
    }

    const orderMatch = { ...match, orderStatus: { $nin: ['cancelled', 'returned'] } };
    const prevOrderMatch = { ...prevMatch, orderStatus: { $nin: ['cancelled', 'returned'] } };

    const results = await Promise.all([
      // 0. Combined Sales Trend
      Order.aggregate([
        { $match: orderMatch },
        { $project: { revenue: { $ifNull: ['$pricing.totalAmount', 0] }, createdAt: 1 } },
        { $unionWith: { coll: 'bills', pipeline: [ { $match: match }, { $project: { revenue: { $ifNull: ['$pricing.totalAmount', 0] }, createdAt: 1 } } ] }},
        { $group: { _id: groupBy, revenue: { $sum: '$revenue' }, orders: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      // 1. Combined Category Performance
      Order.aggregate([
        { $match: orderMatch },
        { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
        { $unionWith: { 
            coll: 'bills', 
            pipeline: [ 
              { $match: match }, 
              { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } }, 
              { $project: { items: 1 } } 
            ] 
        }},
        { $lookup: { from: 'products', localField: 'items.productId', foreignField: '_id', as: 'product' } },
        { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'categories', localField: 'product.category', foreignField: '_id', as: 'category' } },
        { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $ifNull: ['$category.name', 'Uncategorized'] }, revenue: { $sum: { $ifNull: ['$items.total', 0] } }, count: { $sum: { $ifNull: ['$items.quantity', 0] } } } },
        { $sort: { revenue: -1 } }
      ]),
      // 2. Combined Payment Methods
      Order.aggregate([
        { $match: orderMatch },
        { $project: { method: '$paymentMethod', revenue: { $ifNull: ['$pricing.totalAmount', 0] } } },
        { $unionWith: { coll: 'bills', pipeline: [ { $match: match }, { $project: { method: '$paymentMethod', revenue: { $ifNull: ['$pricing.totalAmount', 0] } } } ] }},
        { $group: { _id: '$method', revenue: { $sum: '$revenue' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } }
      ]),
      // 3. Regional Performance (Including Offline as Tamil Nadu)
      Order.aggregate([
        { $match: orderMatch },
        { $project: { state: { $ifNull: ['$shippingAddress.state', 'Tamil Nadu'] }, revenue: { $ifNull: ['$pricing.totalAmount', 0] } } },
        { $unionWith: { coll: 'bills', pipeline: [ { $match: match }, { $project: { state: 'Tamil Nadu', revenue: { $ifNull: ['$pricing.totalAmount', 0] } } } ] }},
        { $group: { _id: '$state', revenue: { $sum: '$revenue' }, orders: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 8 }
      ]),
      // 4. Combined Summary & Growth
      Promise.all([
        Order.aggregate([
          { $match: orderMatch },
          { $unionWith: { coll: 'bills', pipeline: [ { $match: match } ] }},
          { $group: { _id: null, totalRevenue: { $sum: '$pricing.totalAmount' }, totalOrders: { $sum: 1 } } }
        ]),
        Order.aggregate([
          { $match: prevOrderMatch },
          { $unionWith: { coll: 'bills', pipeline: [ { $match: prevMatch } ] }},
          { $group: { _id: null, totalRevenue: { $sum: '$pricing.totalAmount' } } }
        ])
      ]),
      // 5. ERP: Dead Stock
      Inventory.aggregate([
        { $addFields: { 
            sold: { $add: [{ $ifNull: ['$onlineSold', 0] }, { $ifNull: ['$offlineSold', 0] }] },
            ageDays: { $divide: [{ $subtract: [new Date(), { $ifNull: ['$createdAt', new Date()] }] }, 86400000] }
        }},
        { $match: { sold: 0, totalStock: { $gt: 0 }, ageDays: { $gt: 30 } } },
        { $limit: 10 }
      ]),
      // 6. ERP: Low Margin Products
      Inventory.aggregate([
        { $addFields: {
            margin: { $cond: [{ $gt: [{ $ifNull: ['$sellingPrice', 0] }, 0] }, { $divide: [{ $subtract: ['$sellingPrice', '$purchasePrice'] }, '$sellingPrice'] }, 0] }
        }},
        { $match: { margin: { $lt: 0.20 }, sellingPrice: { $gt: 0 } } },
        { $sort: { margin: 1 } },
        { $limit: 10 }
      ]),
      // 7. ERP: Stock Aging
      Inventory.aggregate([
        { $addFields: { 
            age: { $divide: [{ $subtract: [new Date(), { $ifNull: ['$createdAt', new Date()] }] }, 86400000] } 
        }},
        { $group: {
            _id: {
              $cond: [
                { $lt: ['$age', 30] }, '0-30 Days',
                { $cond: [{ $lt: ['$age', 60] }, '31-60 Days', '60+ Days'] }
              ]
            },
            count: { $sum: 1 },
            value: { $sum: { $multiply: [{ $ifNull: ['$purchasePrice', 0] }, { $subtract: [{ $ifNull: ['$totalStock', 0] }, { $add: [{ $ifNull: ['$onlineSold', 0] }, { $ifNull: ['$offlineSold', 0] }, { $ifNull: ['$damaged', 0] }] }] }] } }
        }}
      ])
    ]);

    const currentStats = results[4][0][0] || { totalRevenue: 0, totalOrders: 0 };
    const previousStats = results[4][1][0] || { totalRevenue: 0 };
    
    // Calculate Growth %
    let growth = 0;
    if (previousStats.totalRevenue > 0) {
      growth = parseFloat(((currentStats.totalRevenue - previousStats.totalRevenue) / previousStats.totalRevenue * 100).toFixed(1));
    } else if (currentStats.totalRevenue > 0) {
      growth = 100;
    }

    // --- HIGH IMPACT FEATURES (ADDITIONAL DATA) ---
    const [extraMetrics, recentActivity] = await Promise.all([
      // 1. Staff Leaderboard (From Bills)
      Bill.aggregate([
        { $match: match },
        { $group: { _id: '$staffId', totalSales: { $sum: '$pricing.totalAmount' }, txns: { $sum: 1 } } },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'staff' } },
        { $unwind: { path: '$staff', preserveNullAndEmptyArrays: true } },
        { $project: { name: { $ifNull: ['$staff.name', 'System Admin'] }, totalSales: 1, txns: 1 } },
        { $sort: { totalSales: -1 } },
        { $limit: 5 }
      ]),
      // 2. Recent Combined Activity (Real-time Stream)
      Promise.all([
        Order.find().sort({ createdAt: -1 }).limit(10).select('billNumber pricing.totalAmount createdAt isGuestOrder shippingAddress.name'),
        Bill.find().sort({ createdAt: -1 }).limit(10).select('billNumber pricing.totalAmount createdAt staffName customerDetails.name')
      ]).then(([orders, bills]) => {
        const combined = [
          ...orders.map(o => ({ type: 'ONLINE', id: o.billNumber || 'ORD', total: o.pricing.totalAmount, date: o.createdAt, name: o.shippingAddress?.name || 'Guest' })),
          ...bills.map(b => ({ type: 'OFFLINE', id: b.billNumber, total: b.pricing.totalAmount, date: b.createdAt, name: b.customerDetails?.name || 'Retail' }))
        ];
        return combined.sort((a,b) => b.date - a.date).slice(0, 15);
      }),
      // 3. Top Products with Images
      Order.aggregate([
        { $match: orderMatch },
        { $unwind: '$items' },
        { $unionWith: { coll: 'bills', pipeline: [ { $match: match }, { $unwind: '$items' } ] }},
        { $group: { _id: '$items.productId', name: { $first: '$items.productName' }, qty: { $sum: '$items.quantity' }, rev: { $sum: '$items.total' } } },
        { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'p' } },
        { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
        { $project: { name: 1, qty: 1, rev: 1, image: { $arrayElemAt: ['$p.images', 0] } } },
        { $sort: { qty: -1 } },
        { $limit: 8 }
      ])
    ]);

    const staffPerformance = extraMetrics;
    const topProducts = await Promise.resolve(recentActivity); // Wait, I misaligned indices
    const topProductsVisual = (await Promise.all([Order.aggregate([
      { $match: orderMatch },
      { $unwind: '$items' },
      { $unionWith: { coll: 'bills', pipeline: [ { $match: match }, { $unwind: '$items' } ] }},
      { $group: { _id: '$items.productId', name: { $first: '$items.productName' }, qty: { $sum: '$items.quantity' }, rev: { $sum: '$items.total' } } },
      { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'p' } },
      { $unwind: { path: '$p', preserveNullAndEmptyArrays: true } },
      { $project: { name: 1, qty: 1, rev: 1, image: { $arrayElemAt: ['$p.images', 0] } } },
      { $sort: { qty: -1 } },
      { $limit: 8 }
    ])]))[0];

    const finalAnalytics = { 
      data: results[0], 
      categoryData: results[1], 
      paymentData: results[2], 
      locationData: results[3],
      summary: {
        totalRevenue: currentStats.totalRevenue,
        totalOrders: currentStats.totalOrders,
        growth: growth,
        avgTicket: currentStats.totalRevenue / (currentStats.totalOrders || 1)
      },
      staffPerformance,
      recentActivity: recentActivity,
      topProducts: topProductsVisual,
      erp: {
        deadStock: results[5],
        lowMarginItems: results[6],
        stockAging: results[7]
      }
    };

    analyticsCache[cacheKey] = { data: finalAnalytics, lastUpdated: Date.now() };

    return ApiResponse.success(res, finalAnalytics);
  } catch (error) { 
    console.error('Analytics Error:', error);
    return res.status(500).json({ success: false, message: 'Analytics aggregation failed', error: error.message });
  }
};

exports.getAllUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    
    // 1. Fetch Registered Users
    const userQuery = {};
    if (role && role !== 'guest') userQuery.role = role;
    if (search) userQuery.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];

    // 1. Fetch Registered Users with Stats
    let users = [];
    let totalUsers = 0;

    if (role !== 'guest') {
      users = await User.aggregate([
        { $match: userQuery },
        { $lookup: {
            from: 'orders',
            localField: '_id',
            foreignField: 'userId',
            as: 'orders'
        }},
        { $project: {
            _id: 1, name: 1, email: 1, phone: 1, role: 1, isBlocked: 1, createdAt: 1,
            orderCount: { $size: '$orders' },
            totalSpent: { $sum: '$orders.pricing.totalAmount' }
        }},
        { $sort: { createdAt: -1 } }
      ]);
      totalUsers = users.length;
    }

    // 2. Fetch Unique Guests from Orders with Stats
    let guests = [];
    if (!role || role === 'guest' || role === 'user') {
      const guestMatch = { 
        $or: [
          { userId: null }, 
          { isGuestOrder: true }, 
          { userId: { $exists: false } }
        ] 
      };
      
      if (search) {
        const searchCriteria = {
          $or: [
            { 'shippingAddress.name': { $regex: search, $options: 'i' } },
            { 'shippingAddress.phone': { $regex: search, $options: 'i' } },
            { 'guestDetails.name': { $regex: search, $options: 'i' } },
            { 'guestDetails.phone': { $regex: search, $options: 'i' } }
          ]
        };
        var finalGuestMatch = { $and: [ guestMatch, searchCriteria ] };
      } else {
        var finalGuestMatch = guestMatch;
      }

      guests = await Order.aggregate([
        { $match: finalGuestMatch },
        { $group: {
            _id: { $ifNull: ['$shippingAddress.phone', '$guestDetails.phone'] },
            name: { $first: { $ifNull: ['$shippingAddress.name', '$guestDetails.name'] } },
            email: { $first: { $ifNull: ['$shippingAddress.email', '$guestDetails.email'] } },
            phone: { $first: { $ifNull: ['$shippingAddress.phone', '$guestDetails.phone'] } },
            createdAt: { $min: '$createdAt' },
            orderCount: { $sum: 1 },
            totalSpent: { $sum: '$pricing.totalAmount' }
        }},
        { $project: { 
            _id: { $concat: ["guest_", { $ifNull: ["$phone", { $toString: "$_id" }] }] }, 
            name: 1, email: 1, phone: 1, createdAt: 1, orderCount: 1, totalSpent: 1,
            role: { $literal: 'guest' }, 
            isBlocked: { $literal: false } 
        }}
      ]);
    }

    // 3. Merge and Paginate
    let allCustomers = [...users, ...guests];
    allCustomers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    const total = allCustomers.length;
    const paginatedItems = allCustomers.slice(skip, skip + Number(limit));

    return ApiResponse.paginated(res, paginatedItems, { 
      page: Number(page), 
      limit: Number(limit), 
      total, 
      pages: Math.ceil(total / Number(limit)) 
    });
  } catch (error) { next(error); }
};

exports.toggleBlockUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return ApiResponse.notFound(res, 'User not found');
    user.isBlocked = !user.isBlocked;
    await user.save();
    return ApiResponse.success(res, null, `User ${user.isBlocked ? 'blocked' : 'unblocked'}`);
  } catch (error) { next(error); }
};

exports.createStaff = async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body;
    const staff = await User.create({ name, email, phone, password, role: 'staff', isVerified: true });
    return ApiResponse.created(res, { staff: { _id: staff._id, name, email, phone, role: 'staff' } }, 'Staff account created');
  } catch (error) { next(error); }
};

exports.updateStaff = async (req, res, next) => {
  try {
    const { name, email, phone, password } = req.body;
    const staff = await User.findOne({ _id: req.params.id, role: 'staff' });
    if (!staff) return ApiResponse.notFound(res, 'Staff not found');

    staff.name = name || staff.name;
    staff.email = email || staff.email;
    staff.phone = phone || staff.phone;
    if (password) staff.password = password;

    await staff.save();
    return ApiResponse.success(res, { staff: { _id: staff._id, name: staff.name, email: staff.email, phone: staff.phone, role: 'staff' } }, 'Staff account updated');
  } catch (error) { next(error); }
};

exports.getStaff = async (req, res, next) => {
  try {
    const staff = await User.find({ role: 'staff' }).select('-password -refreshToken').sort({ createdAt: -1 });
    return ApiResponse.success(res, staff);
  } catch (error) { next(error); }
};

exports.deleteStaff = async (req, res, next) => {
  try {
    const staff = await User.findOneAndDelete({ _id: req.params.id, role: 'staff' });
    if (!staff) return ApiResponse.notFound(res, 'Staff not found');
    return ApiResponse.success(res, null, 'Staff account deleted');
  } catch (error) { next(error); }
};

exports.getStaffPerformance = async (req, res, next) => {
  try {
    const performance = await Bill.aggregate([
      {
        $group: {
          _id: '$staffId',
          totalSales: { $sum: '$pricing.totalAmount' },
          totalBills: { $sum: 1 },
          totalCommission: { $sum: '$commissionAmount' }
        }
      },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'staff'
        }
      },
      { $unwind: '$staff' },
      {
        $project: {
          name: '$staff.name',
          totalSales: 1,
          totalBills: 1,
          totalCommission: 1,
          commissionRate: '$staff.commissionRate'
        }
      },
      { $sort: { totalSales: -1 } }
    ]);
    return ApiResponse.success(res, performance);
  } catch (error) { next(error); }
};

exports.getLowStock = async (req, res, next) => {
  try {
    const lowStock = await Inventory.aggregate(lowStockPipeline);
    return ApiResponse.success(res, lowStock);
  } catch (error) { next(error); }
};
exports.updateSettings = async (req, res, next) => {
  try {
    const { testAlert, ...settingsData } = req.body;
    
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create(settingsData);
    } else {
      // ── SANITIZATION: Admin Notification Email ──
      if (settingsData.notifications?.email?.alertEmail) {
        let email = settingsData.notifications.email.alertEmail.trim().toLowerCase();
        
        // Basic Email Validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return ApiResponse.error(res, 'Invalid Admin Notification Email format', 400);
        }
        
        settingsData.notifications.email.alertEmail = email;
      }

      // ── PREVENTION: Don't overwrite password/API key with empty strings ──
      // Use a flat object to update specific nested fields without overwriting entire sub-objects
      const updateData = {};
      
      const flatten = (obj, prefix = '') => {
        Object.keys(obj).forEach(key => {
          const value = obj[key];
          const newKey = prefix ? `${prefix}.${key}` : key;
          
          // Skip sensitive fields if they are empty
          const isSensitive = ['password', 'apiKey', 'razorpayKeySecret'].includes(key);
          if (isSensitive && !value) return;

          if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof mongoose.Types.ObjectId)) {
            flatten(value, newKey);
          } else {
            updateData[newKey] = value;
          }
        });
      };

      flatten(settingsData);
      
      settings = await Settings.findByIdAndUpdate(settings._id, { $set: updateData }, { returnDocument: 'after' });
    }

    if (testAlert) {
      const logger = require('../utils/logger');
      const testType = req.body.testType || 'all';
      logger.info(`🧪 Manual ${testType.toUpperCase()} Test Alert Triggered via Settings`);
      
      const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
      const whatsapp = require('../services/whatsapp.service');
      const emailService = require('../services/email.service');

      // 1. Low Stock Test
      if (testType === 'all' || testType === 'stock') {
        checkAndAlertLowStock({
          productName: 'TEST PRODUCT (SETTINGS TEST)',
          color: 'GOLD', size: 'XL', availableStock: 2, lowStockThreshold: 5
        }).catch(e => logger.error('Low Stock Test Error:', e.message));
      }

      // 2. Order Alert Test
      if (testType === 'all' || testType === 'order') {
        const dummyOrder = {
          _id: '507f1f77bcf86cd799439011',
          orderNumber: 'TEST-ORDER-999',
          shippingAddress: { name: 'Test Customer', phone: settings.notifications?.whatsapp?.adminPhone || '9384765475' },
          pricing: { totalAmount: 1500 },
          paymentMethod: 'UPI',
          items: [{ productName: 'Premium Cotton Shirt', variant: { size: 'XL', color: 'White' }, quantity: 1 }]
        };
        
        const orderNotif = settings.notifications?.orderNotifications || { enabled: true, method: 'both' };
        if (orderNotif.enabled) {
          if (['whatsapp', 'both'].includes(orderNotif.method)) {
            whatsapp.sendOrderNotificationToAdmin(dummyOrder).catch(e => logger.error('Order Test WhatsApp Error:', e.message));
          }
          if (['email', 'both'].includes(orderNotif.method)) {
            emailService.sendAdminOrderNotificationEmail(dummyOrder).catch(e => logger.error('Order Test Email Error:', e.message));
          }
        }
      }

      // 3. Contact Alert Test
      if (testType === 'all' || testType === 'contact') {
        const dummyContact = {
          name: 'Test Inquirer',
          email: 'test@example.com',
          phone: '9876543210',
          subject: 'Website Test Inquiry',
          message: 'This is a test contact message to verify your notification settings.'
        };
        
        const contactNotif = settings.notifications?.contactNotifications || { enabled: true, method: 'both' };
        if (contactNotif.enabled) {
          if (['whatsapp', 'both'].includes(contactNotif.method)) {
            whatsapp.sendContactMessageNotificationToAdmin(dummyContact).catch(e => logger.error('Contact Test WhatsApp Error:', e.message));
          }
          if (['email', 'both'].includes(contactNotif.method)) {
            emailService.sendAdminContactNotificationEmail(dummyContact).catch(e => logger.error('Contact Test Email Error:', e.message));
          }
        }
      }
    }

    return ApiResponse.success(res, settings, 'Settings updated successfully');
  } catch (error) { next(error); }
};

exports.getSettings = async (req, res, next) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    return ApiResponse.success(res, settings);
  } catch (error) { next(error); }
};

exports.getPublicSettings = async (req, res, next) => {
  try {
    const settings = await Settings.findOne()
      .select('store shipping payment seo')
      .lean();
    
    // Ensure the response structure is always complete even if DB doc is empty
    const response = {
      store: { 
        name: 'Magizhchi Garments', email: '', phone: '', address: '', gstin: '', 
        ...(settings?.store || {}) 
      },
      shipping: { 
        flatRateTN: 50, flatRateOut: 100, freeShippingThreshold: 999,
        ...(settings?.shipping || {}) 
      },
      payment: { 
        onlineEnabled: true, codEnabled: true, codCharges: 50, codThreshold: 50000,
        ...(settings?.payment || {}) 
      },
      seo: settings?.seo || {}
    };

    return ApiResponse.success(res, response);
  } catch (error) { next(error); }
};
exports.testNotifications = async (req, res, next) => {
  try {
    const { type = 'all', phone, email } = req.body;
    const results = { whatsapp: null, email: null };
    const logger = require('../utils/logger');
    const whatsapp = require('../services/whatsapp.service');
    const emailService = require('../services/email.service');

    const testMsg = `🧪 *Magizhchi Notification Test*\nSent at: ${new Date().toLocaleString()}\nStatus: Active`;

    // 1. Test WhatsApp
    if (type === 'all' || type === 'whatsapp') {
      try {
        const targetPhone = phone || (await Settings.findOne())?.notifications?.whatsapp?.adminPhone || process.env.STORE_PHONE;
        if (!targetPhone) throw new Error('No target phone number provided or found in settings');
        
        await whatsapp.sendMessage(targetPhone, testMsg);
        results.whatsapp = { success: true, message: `Test message sent to ${targetPhone}` };
      } catch (err) {
        results.whatsapp = { success: false, error: err.message };
        logger.error('🧪 WhatsApp Test Failed:', err.message);
      }
    }

    // 2. Test Email
    if (type === 'all' || type === 'email') {
      try {
        const settings = await Settings.findOne();
        const targetEmail = settings?.notifications?.email?.alertEmail || settings?.store?.email;
        
        if (!targetEmail) throw new Error('No Admin Notification Email configured in settings');

        const { getTransporter } = require('../config/email');
        const transporter = await getTransporter();
        const { from } = await require('../services/email.service').getEmailSettings();

        await transporter.sendMail({
          from,
          to: targetEmail,
          subject: '🧪 Magizhchi Notification Test',
          text: `This is a test email to verify your SMTP settings.\nSent at: ${new Date().toLocaleString()}`,
          html: `<h3>🧪 Magizhchi Notification Test</h3><p>Your SMTP settings are working correctly.</p><p>Sent at: ${new Date().toLocaleString()}</p>`
        });
        results.email = { success: true, message: `Test email sent to ${targetEmail}` };
      } catch (err) {
        results.email = { success: false, error: err.message };
        logger.error('🧪 Email Test Failed:', err.message);
      }
    }

    return ApiResponse.success(res, results, 'Notification tests completed');
  } catch (error) { next(error); }
};
