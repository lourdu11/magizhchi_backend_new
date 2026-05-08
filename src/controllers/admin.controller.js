const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Bill = require('../models/Bill');
const Settings = require('../models/Settings');
const ApiResponse = require('../utils/apiResponse');
const Inventory = require('../models/Inventory');
const Purchase = require('../models/Purchase');

// Cache disabled for real-time accuracy during development/rapid testing
let dashboardCache = { data: null, lastUpdated: 0 };
const CACHE_TTL = 0; // Set to 0 to force refresh every time

const lowStockPipeline = [
  { $match: { isDeleted: { $ne: true }, $or: [{ onlineEnabled: true }, { offlineEnabled: true }] } },
  { $addFields: {
      availableStock: {
        $max: [0, { $subtract: [
          { $add: ['$totalStock', '$returned'] },
          { $add: ['$onlineSold', '$offlineSold', { $ifNull: ['$reservedStock', 0] }, '$damaged'] }
        ]}]
      }
  }},
  { $match: { availableStock: { $gt: 0 }, $expr: { $lte: ['$availableStock', { $ifNull: ['$lowStockThreshold', 5] }] } } },
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
              { $match: { status: { $ne: 'voided' } } },
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
      // 2. Low Stock Inventory (excludes archived + zero-stock variants)
      Inventory.find({ 
        isDeleted: { $ne: true },
        $or: [{ onlineEnabled: true }, { offlineEnabled: true }],
        availableStock: { $gt: 0 },
        $expr: { $lte: ['$availableStock', '$lowStockThreshold'] } 
      }).limit(10).lean(),
      // 3. Supplier Payables & Partner Stats (Strictly Active Partners)
      require('../models/Supplier').aggregate([
        { $match: { isDeleted: false, isActive: true } }, 
        {
          $group: {
            _id: null,
            totalPayables: { $sum: { $subtract: [{ $add: ['$openingBalance', '$totalPurchaseAmount'] }, '$totalPaidAmount'] } },
            activePartners: { $sum: 1 },
            procurementVolume: { $sum: { $add: ['$openingBalance', '$totalPurchaseAmount'] } },
            settledValue: { $sum: '$totalPaidAmount' }
          }
        }
      ]),
      // 4. Wastage
      require('../models/Wastage').aggregate([
        { $match: { createdAt: { $gte: today } } },
        { $group: { _id: null, todayLoss: { $sum: '$lossAmount' } } }
      ])
    ]);

    const stats = revenueStats[0] || { todayRevenue: 0, todayCost: 0, monthRevenue: 0 };
    const payables = supplierStats[0] || {};
    const wastageLoss = wastageStats[0]?.todayLoss || 0;

    const finalData = {
      revenue: {
        today: stats.todayRevenue,
        month: stats.monthRevenue,
        todayProfit: stats.todayRevenue - stats.todayCost,
      },
      erp: {
        totalPayables: payables.totalPayables || 0,
        procurementVolume: payables.procurementVolume || 0,
        settledValue: payables.settledValue || 0,
        activePartners: payables.activePartners || 0,
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
const ANALYTICS_TTL = 0; // Set to 0 to force real-time recalculation every time

exports.getSalesAnalytics = async (req, res, next) => {
  try {
    const { period = 'monthly', year = new Date().getFullYear() } = req.query;
    const cacheKey = `${period}-${year}`;

    // Cache disabled for 'Original' data integrity
    if (ANALYTICS_TTL > 0 && analyticsCache[cacheKey] && (Date.now() - analyticsCache[cacheKey].lastUpdated < ANALYTICS_TTL)) {
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
        { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...match, status: { $ne: 'voided' } } }, { $project: { revenue: { $ifNull: ['$pricing.totalAmount', 0] }, createdAt: 1 } } ] }},
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
              { $match: { ...match, status: { $ne: 'voided' } } }, 
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
        { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...match, status: { $ne: 'voided' } } }, { $project: { method: '$paymentMethod', revenue: { $ifNull: ['$pricing.totalAmount', 0] } } } ] }},
        { $group: { _id: '$method', revenue: { $sum: '$revenue' }, count: { $sum: 1 } } },
        { $sort: { revenue: -1 } }
      ]),
      // 3. Regional Performance (Including Offline as Tamil Nadu)
      Order.aggregate([
        { $match: orderMatch },
        { $project: { state: { $ifNull: ['$shippingAddress.state', 'Tamil Nadu'] }, revenue: { $ifNull: ['$pricing.totalAmount', 0] } } },
        { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...match, status: { $ne: 'voided' } } }, { $project: { state: 'Tamil Nadu', revenue: { $ifNull: ['$pricing.totalAmount', 0] } } } ] }},
        { $group: { _id: '$state', revenue: { $sum: '$revenue' }, orders: { $sum: 1 } } },
        { $sort: { revenue: -1 } },
        { $limit: 8 }
      ]),
      // 4. Combined Summary & Growth
      Promise.all([
        Order.aggregate([
          { $match: orderMatch },
          { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...match, status: { $ne: 'voided' } } } ] }},
          { $group: { _id: null, totalRevenue: { $sum: '$pricing.totalAmount' }, totalOrders: { $sum: 1 } } }
        ]),
        Order.aggregate([
          { $match: prevOrderMatch },
          { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...prevMatch, status: { $ne: 'voided' } } } ] }},
          { $group: { _id: null, totalRevenue: { $sum: '$pricing.totalAmount' } } }
        ])
      ]),
      // 5. ERP: Dead Stock (excludes archived variants)
      Inventory.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $addFields: { 
            sold: { $add: [{ $ifNull: ['$onlineSold', 0] }, { $ifNull: ['$offlineSold', 0] }] },
            ageDays: { $divide: [{ $subtract: [new Date(), { $ifNull: ['$createdAt', new Date()] }] }, 86400000] }
        }},
        { $match: { sold: 0, totalStock: { $gt: 0 }, ageDays: { $gt: 30 } } },
        { $limit: 10 }
      ]),
      // 6. ERP: Low Margin Products (excludes archived variants)
      Inventory.aggregate([
        { $match: { isDeleted: { $ne: true } } },
        { $addFields: {
            margin: { $cond: [{ $gt: [{ $ifNull: ['$sellingPrice', 0] }, 0] }, { $divide: [{ $subtract: ['$sellingPrice', '$purchasePrice'] }, '$sellingPrice'] }, 0] }
        }},
        { $match: { margin: { $lt: 0.20 }, sellingPrice: { $gt: 0 } } },
        { $sort: { margin: 1 } },
        { $limit: 10 }
      ]),
      // 7. ERP: Stock Aging (excludes archived variants)
      Inventory.aggregate([
        { $match: { isDeleted: { $ne: true } } },
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
      ]),
      // 8. ERP: Supplier Exposure (Strictly Active Partners)
      require('../models/Supplier').aggregate([
        { $match: { isDeleted: false, isActive: true } },
        { $group: {
            _id: null,
            totalPayables: { $sum: { $subtract: [{ $add: ['$openingBalance', '$totalPurchaseAmount'] }, '$totalPaidAmount'] } },
            activePartners: { $sum: 1 }
        }}
      ])
    ]);

    const supplierAnalysis = results[8][0] || { totalPayables: 0, activePartners: 0 };

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
        { $match: { ...match, status: { $ne: 'voided' } } },
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
        Bill.find({ status: { $ne: 'voided' } }).sort({ createdAt: -1 }).limit(10).select('billNumber pricing.totalAmount createdAt staffName customerDetails.name')
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
        { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...match, isDeleted: { $ne: true } } }, { $unwind: '$items' } ] }},
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
      { $unionWith: { coll: 'bills', pipeline: [ { $match: { ...match, status: { $ne: 'voided' } } }, { $unwind: '$items' } ] }},
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
        stockAging: results[7],
        totalPayables: supplierAnalysis.totalPayables,
        activePartners: supplierAnalysis.activePartners,
        inventoryValue: results[7].reduce((sum, aged) => sum + aged.value, 0)
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
    if (role && role !== 'guest') {
      userQuery.role = role;
    } else {
      userQuery.role = 'user';
    }
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
      { $match: { status: { $ne: 'voided' } } },
      {
        $group: {
          _id: { $ifNull: ['$salesStaffId', '$staffId'] },
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
    
    // ── AGGRESSIVE SINGLETON ENFORCEMENT ──
    // Ensure only one settings document exists in the collection to prevent stale reads
    const allSettings = await Settings.find().sort({ createdAt: 1 });
    if (allSettings.length > 1) {
      const mainId = allSettings[0]._id;
      await Settings.deleteMany({ _id: { $ne: mainId } });
      const logger = require('../utils/logger');
      logger.info(`🧹 DB CLEANUP: Removed ${allSettings.length - 1} redundant settings documents.`);
    }

    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create(settingsData);
    } else {
      const updateData = {};
      
      // 1. Sanitize & Map Email Notifications with strict database update
      let sanitizedEmail = '';
      if (settingsData.notifications?.email) {
        const rawEmail = settingsData.notifications.email.alertEmail || '';
        sanitizedEmail = rawEmail.trim().split(/[\s,;]/)[0].toLowerCase();
        
        if (sanitizedEmail) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(sanitizedEmail)) {
            return ApiResponse.error(res, 'Invalid admin notification email format', 400);
          }
        }
        updateData['notifications.email.alertEmail'] = sanitizedEmail;
        updateData['notifications.email.apiKey'] = settingsData.notifications.email.apiKey;
      }

      // 2. Map WhatsApp Notifications
      if (settingsData.notifications?.whatsapp) {
        updateData['notifications.whatsapp.adminPhone'] = settingsData.notifications.whatsapp.adminPhone || '';
      }

      // 3. Map Feature Toggles (Order, Contact, Stock)
      if (settingsData.notifications?.orderNotifications) {
        updateData['notifications.orderNotifications'] = settingsData.notifications.orderNotifications;
      }
      if (settingsData.notifications?.contactNotifications) {
        updateData['notifications.contactNotifications'] = settingsData.notifications.contactNotifications;
      }
      if (settingsData.notifications?.lowStockAlert) {
        updateData['notifications.lowStockAlert'] = settingsData.notifications.lowStockAlert;
      }

      // 4. Handle other top-level fields (Store, Shipping, Payment, etc.)
      if (settingsData.store) updateData['store'] = settingsData.store;
      if (settingsData.shipping) updateData['shipping'] = settingsData.shipping;
      if (settingsData.payment) updateData['payment'] = settingsData.payment;
      if (settingsData.seo) updateData['seo'] = settingsData.seo;
      
      settings = await Settings.findByIdAndUpdate(settings._id, { $set: updateData }, { new: true });
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
          orderNumber: 'TEST-ORDER-BREVO',
          shippingAddress: { name: 'Diagnostic Test', phone: '0000000000' },
          pricing: { totalAmount: 1 },
          paymentMethod: 'TEST',
          items: [{ productName: 'Diagnostic Ping', variant: { size: 'N/A', color: 'N/A' }, quantity: 1 }]
        };
        
        const orderNotif = settings.notifications?.orderNotifications || { enabled: true, method: 'both' };
        if (orderNotif.enabled) {
          if (['whatsapp', 'both'].includes(orderNotif.method)) {
            whatsapp.sendOrderNotificationToAdmin(dummyOrder).catch(e => logger.error('Order Test WhatsApp Error:', e.message));
          }
          if (['email', 'both'].includes(orderNotif.method)) {
            try {
              await emailService.sendAdminOrderNotificationEmail(dummyOrder);
            } catch (e) {
              logger.error('Order Test Email Error:', e.message);
              return res.status(500).json({ success: false, message: `Email Delivery Failed: ${e.message}` });
            }
          }
        }
      }

      // 3. Contact Alert Test
      if (testType === 'all' || testType === 'contact') {
        const dummyContact = {
          name: 'John Doe',
          email: 'johndoe.contact@gmail.com',
          phone: '9876543210',
          subject: 'Question about your products',
          message: 'Hello, I would like to know more about the available sizes for your latest collection.'
        };
        
        const contactNotif = settings.notifications?.contactNotifications || { enabled: true, method: 'both' };
        if (contactNotif.enabled) {
          if (['whatsapp', 'both'].includes(contactNotif.method)) {
            whatsapp.sendContactMessageNotificationToAdmin(dummyContact).catch(e => logger.error('Contact Test WhatsApp Error:', e.message));
          }
          if (['email', 'both'].includes(contactNotif.method)) {
            try {
              await emailService.sendAdminContactNotificationEmail(dummyContact);
            } catch (e) {
              logger.error('Contact Test Email Error:', e.message);
              return res.status(500).json({ success: false, message: `Email Delivery Failed: ${e.message}` });
            }
          }
        }
      }
    }

    return ApiResponse.success(res, settings, 'Settings updated successfully');
  } catch (error) { next(error); }
};

exports.getSettings = async (req, res, next) => {
  try {
    // ── AGGRESSIVE SINGLETON ENFORCEMENT ──
    const allSettings = await Settings.find().sort({ createdAt: 1 });
    if (allSettings.length > 1) {
      const mainId = allSettings[0]._id;
      await Settings.deleteMany({ _id: { $ne: mainId } });
    }

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
// ─── Per-admin cooldown to prevent duplicate test sends ───────────────────────
const _testCooldowns = {};
const TEST_COOLDOWN_MS = 45000; // 45 seconds per type

exports.testNotifications = async (req, res, next) => {
  try {
    const { type = 'order' } = req.body;
    const logger = require('../utils/logger');
    const emailService = require('../services/email.service');
    const whatsapp = require('../services/whatsapp.service');

    // ── RATE LIMIT: prevent duplicate sends ──────────────────────────────────
    const cooldownKey = `${req.user?._id || 'admin'}_${type}`;
    const now = Date.now();
    if (_testCooldowns[cooldownKey] && now - _testCooldowns[cooldownKey] < TEST_COOLDOWN_MS) {
      const wait = Math.ceil((TEST_COOLDOWN_MS - (now - _testCooldowns[cooldownKey])) / 1000);
      return res.status(429).json({ success: false, message: `⏳ Please wait ${wait}s before sending another test.` });
    }
    _testCooldowns[cooldownKey] = now;

    // ── FETCH SETTINGS ────────────────────────────────────────────────────────
    const settings = await Settings.findOne().lean();

    // ── VALIDATE ADMIN EMAIL FIRST ────────────────────────────────────────────
    const rawAdminEmail = (settings?.notifications?.email?.alertEmail || '').trim();
    const VALID_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const adminEmail = rawAdminEmail.split(/[\s,;]+/)[0].toLowerCase();

    if (!adminEmail || !VALID_EMAIL_RE.test(adminEmail)) {
      logger.error(`❌ [TEST-BLOCK] Admin email invalid or missing: "${rawAdminEmail}"`);
      return res.status(400).json({
        success: false,
        message: `❌ Admin notification email is not saved or is invalid. Go to Settings → Notifications → Alert Email and save a valid email first.`
      });
    }

    logger.info(`🧪 Test [${type.toUpperCase()}] → SINGLE RECIPIENT: ${adminEmail}`);

    const results = {};

    // ── DUMMY DATA ─────────────────────────────────────────────────────────────
    const dummyOrder = {
      _id: '507f1f77bcf86cd799439011',
      orderNumber: `TEST-${Date.now().toString().slice(-5)}`,
      shippingAddress: { name: 'Test Customer', phone: '9000000000' },
      pricing: { totalAmount: 1 },
      paymentMethod: 'TEST',
      items: [{ productName: 'Test Item', variant: { size: 'M', color: 'Blue' }, quantity: 1 }]
    };

    const dummyContact = {
      name: 'Test User',
      email: 'test@example.com',
      phone: '9000000000',
      subject: 'Test Inquiry',
      message: 'This is a test message from the admin notification test panel.'
    };

    // ── ORDER TEST ─────────────────────────────────────────────────────────────
    if (type === 'order') {
      const method = settings?.notifications?.orderNotifications?.method || 'email';

      if (['email', 'both'].includes(method)) {
        try {
          const r = await emailService.sendAdminOrderNotificationEmail(dummyOrder);
          results.emailOrder = { success: true, message: `✅ Email sent to ${adminEmail} only`, messageId: r?.messageId || 'delivered' };
          logger.info(`✅ Test order email → ${adminEmail}`);
        } catch (e) {
          results.emailOrder = { success: false, error: e.message };
          logger.error('Order Email Test Error:', e.message);
        }
      }

      if (['whatsapp', 'both'].includes(method)) {
        try {
          await whatsapp.sendOrderNotificationToAdmin(dummyOrder);
          results.whatsappOrder = { success: true, message: 'WhatsApp order alert sent' };
        } catch (e) {
          results.whatsappOrder = { success: false, error: e.message };
        }
      }
    }

    // ── CONTACT TEST ───────────────────────────────────────────────────────────
    if (type === 'contact') {
      const method = settings?.notifications?.contactNotifications?.method || 'email';

      if (['email', 'both'].includes(method)) {
        try {
          const r = await emailService.sendAdminContactNotificationEmail(dummyContact);
          results.emailContact = { success: true, message: `✅ Email sent to ${adminEmail} only`, messageId: r?.messageId || 'delivered' };
          logger.info(`✅ Test contact email → ${adminEmail}`);
        } catch (e) {
          results.emailContact = { success: false, error: e.message };
          logger.error('Contact Email Test Error:', e.message);
        }
      }

      if (['whatsapp', 'both'].includes(method)) {
        try {
          await whatsapp.sendContactMessageNotificationToAdmin(dummyContact);
          results.whatsappContact = { success: true, message: 'WhatsApp contact alert sent' };
        } catch (e) {
          results.whatsappContact = { success: false, error: e.message };
        }
      }
    }

    // ── STOCK TEST ─────────────────────────────────────────────────────────────
    if (type === 'stock') {
      try {
        const { checkAndAlertLowStock } = require('../utils/lowStockAlert');
        await checkAndAlertLowStock({
          productName: 'TEST PRODUCT', color: 'GOLD', size: 'XL',
          availableStock: 2, lowStockThreshold: 5
        });
        results.stock = { success: true, message: `✅ Stock alert sent to ${adminEmail}` };
      } catch (e) {
        results.stock = { success: false, error: e.message };
        logger.error('Stock Test Error:', e.message);
      }
    }

    const anyFail = Object.values(results).find(r => r && !r.success);
    logger.info('🧪 Test results:', results);

    if (anyFail) {
      return res.status(207).json({ success: false, message: `Failed: ${anyFail.error}`, data: results });
    }

    return res.json({ success: true, message: `✅ Test sent to ${adminEmail} only`, data: results });
  } catch (error) { next(error); }
};

exports.getServiceHealth = async (req, res, next) => {
  try {
    const whatsapp = require('../services/whatsapp.service');
    const settings = await Settings.findOne().lean();
    
    const health = {
      whatsapp: whatsapp.getStatus(),
      email: {
        ready: !!settings?.notifications?.email?.apiKey,
        provider: 'Brevo',
        alertEmail: settings?.notifications?.email?.alertEmail || 'Not Set'
      },
      timestamp: new Date()
    };
    
    return ApiResponse.success(res, health);
  } catch (error) { next(error); }
};

exports.resetSystemData = async (req, res, next) => {
  try {
    const { selections } = req.body;
    const logger = require('../utils/logger');
    logger.info(`🚨 CRITICAL ACTION: Admin initiated granular system data reset! Selections:`, selections);

    const result = {
      billsCleared: 0,
      ordersCleared: 0,
      movementsCleared: 0,
      wastagesCleared: 0,
      returnsCleared: 0,
      categoriesCleared: 0,
      productsCleared: 0,
      customersCleared: 0,
      staffCleared: 0,
      bannersCleared: 0,
      reviewsCleared: 0,
      suppliersCleared: 0,
      purchasesCleared: 0,
    };

    // 1. Reset Offline Bills / POS Transactions
    if (selections?.offlineBills || selections?.analysis) {
      const deletedBills = await Bill.deleteMany({});
      const deletedOrders = await Order.deleteMany({});
      const Return = require('../models/Return');
      const deletedReturns = await Return.deleteMany({});

      result.billsCleared = deletedBills.deletedCount;
      result.ordersCleared = deletedOrders.deletedCount;
      result.returnsCleared = deletedReturns.deletedCount;

      // Reset sold counts in Inventory
      await Inventory.updateMany({}, { $set: { offlineSold: 0, onlineSold: 0 } });
    }

    // 2. Reset Stock Movements & Wastage
    if (selections?.analysis) {
      const StockMovement = require('../models/StockMovement');
      const deletedMovements = await StockMovement.deleteMany({});
      const Wastage = require('../models/Wastage');
      const deletedWastages = await Wastage.deleteMany({});

      result.movementsCleared = deletedMovements.deletedCount;
      result.wastagesCleared = deletedWastages.deletedCount;
    }

    // 3. Reset Product Categories
    if (selections?.category) {
      const Category = require('../models/Category');
      const deletedCats = await Category.deleteMany({});
      result.categoriesCleared = deletedCats.deletedCount;
    }

    // 4. Reset Product Catalog
    if (selections?.catalog) {
      const deletedProds = await Product.deleteMany({});
      const deletedInv = await Inventory.deleteMany({});
      result.productsCleared = deletedProds.deletedCount;
    }

    // 5. Reset Customer Users
    if (selections?.customer) {
      const deletedCusts = await User.deleteMany({ role: 'user' });
      result.customersCleared = deletedCusts.deletedCount;
    }

    // 6. Reset Staff Accounts
    if (selections?.staff) {
      const deletedStaff = await User.deleteMany({ role: 'staff' });
      result.staffCleared = deletedStaff.deletedCount;
    }

    // 7. Reset Banner Advertisements
    if (selections?.banners) {
      const Banner = require('../models/Banner');
      const deletedBanners = await Banner.deleteMany({});
      result.bannersCleared = deletedBanners.deletedCount;
    }

    // 8. Reset Customer Reviews
    if (selections?.reviews) {
      const Review = require('../models/Review');
      const deletedReviews = await Review.deleteMany({});
      result.reviewsCleared = deletedReviews.deletedCount;
    }

    // 9. Reset Procurement Hub (Suppliers & Purchases)
    if (selections?.procurement) {
      const Supplier = require('../models/Supplier');
      const deletedSuppliers = await Supplier.deleteMany({});
      const deletedPurchases = await Purchase.deleteMany({});
      result.suppliersCleared = deletedSuppliers.deletedCount;
      result.purchasesCleared = deletedPurchases.deletedCount;
    }

    // Always clear dashboard and analysis cache if anything reset
    if (selections?.dashboard || selections?.analysis || selections?.offlineBills || selections?.procurement) {
      dashboardCache = { data: null, lastUpdated: 0 };
      analyticsCache = {};
    }

    logger.info(`🚨 GRANULAR SYSTEM RESET COMPLETE:`, result);

    return ApiResponse.success(res, result, 'Selected system data modules reset successfully!');
  } catch (error) { next(error); }
};
