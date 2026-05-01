const Bill = require('../models/Bill');
const Order = require('../models/Order');
const Inventory = require('../models/Inventory');
const ApiResponse = require('../utils/apiResponse');

exports.getDailyProfitReport = async (req, res, next) => {
  try {
    const { date } = req.query;
    const start = date ? new Date(date) : new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    const query = { createdAt: { $gte: start, $lte: end } };

    // 1. Fetch Bills and Orders
    const [bills, orders] = await Promise.all([
      Bill.find(query).lean(),
      Order.find({ ...query, paymentStatus: 'completed' }).lean()
    ]);

    // 2. Extract all unique Inventory IDs from items
    const inventoryIds = new Set();
    bills.forEach(b => b.items.forEach(i => inventoryIds.add(i.inventoryId)));
    orders.forEach(o => o.items.forEach(i => inventoryIds.add(i.inventoryId)));

    // 3. Batch fetch all required Inventory rows
    const inventoryMap = {};
    if (inventoryIds.size > 0) {
      const inventories = await Inventory.find({ _id: { $in: Array.from(inventoryIds) } }).lean();
      inventories.forEach(inv => {
        inventoryMap[inv._id.toString()] = inv;
      });
    }

    let totalRevenue = 0;
    let totalCost = 0;
    const categoryStats = {};
    const productStats = {};

    const processBatch = (billOrOrderItems) => {
      for (const item of billOrOrderItems) {
        const qty = item.quantity || 0;
        const revenue = item.total || (item.price * item.quantity) || 0;
        
        // Get cost from pre-fetched map
        const inv = inventoryMap[item.inventoryId?.toString()];
        const costPrice = inv?.purchasePrice || 0;
        const totalItemCost = costPrice * qty;
        const profit = revenue - totalItemCost;

        totalRevenue += revenue;
        totalCost += totalItemCost;

        // Category stats
        const cat = inv?.category || 'Uncategorized';
        if (!categoryStats[cat]) {
          categoryStats[cat] = { category: cat, revenue: 0, cost: 0, profit: 0 };
        }
        categoryStats[cat].revenue += revenue;
        categoryStats[cat].cost += totalItemCost;
        categoryStats[cat].profit += profit;

        // Product stats
        const pName = item.productName;
        if (!productStats[pName]) {
          productStats[pName] = { name: pName, unitsSold: 0, revenue: 0, profit: 0 };
        }
        productStats[pName].unitsSold += qty;
        productStats[pName].revenue += revenue;
        productStats[pName].profit += profit;
      }
    };

    // 4. Process all items from pre-fetched data
    bills.forEach(b => processBatch(b.items));
    orders.forEach(o => processBatch(o.items));

    const grossProfit = totalRevenue - totalCost;
    const marginPercent = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    const report = {
      date: start,
      totalRevenue,
      totalCost,
      grossProfit,
      marginPercent,
      byCategory: Object.values(categoryStats),
      topProducts: Object.values(productStats).sort((a, b) => b.profit - a.profit).slice(0, 10)
    };

    return ApiResponse.success(res, report);
  } catch (error) { next(error); }
};
