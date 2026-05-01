/**
 * Professional Email Template Generator
 */
const generateEmailHTML = (options) => {
  const { title, preheader, body, cta, footer, brandColor = '#4f46e5', storeName = 'Magizhchi Garments' } = options;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f7fa; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
    .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
    .header { background-color: ${brandColor}; padding: 40px 20px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.025em; }
    .content { padding: 40px 30px; line-height: 1.6; color: #374151; }
    .content h2 { color: #111827; font-size: 20px; font-weight: 600; margin-top: 0; }
    .footer { background-color: #f9fafb; padding: 20px 30px; text-align: center; color: #6b7280; font-size: 13px; border-top: 1px solid #e5e7eb; }
    .button { display: inline-block; padding: 12px 24px; background-color: ${brandColor}; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin-top: 20px; }
    .order-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .order-table th { text-align: left; padding: 12px; border-bottom: 2px solid #e5e7eb; color: #4b5563; font-size: 14px; }
    .order-table td { padding: 12px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 12px; font-weight: 500; background-color: #e5e7eb; color: #374151; }
    .text-right { text-align: right; }
    .summary-row { font-weight: 600; color: #111827; }
    .total-row { font-size: 18px; color: ${brandColor}; font-weight: 700; }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${preheader || title}</div>
  <div class="container">
    <div class="header">
      <h1>${storeName}</h1>
    </div>
    <div class="content">
      ${body}
      ${cta ? `<center><a href="${cta.url}" class="button">${cta.text}</a></center>` : ''}
    </div>
    <div class="footer">
      <p>&copy; ${new Date().getFullYear()} ${storeName}. All rights reserved.</p>
      ${footer || '<p>Premium Garments & Textiles</p>'}
    </div>
  </div>
</body>
</html>
  `;
};

/**
 * Format Currency
 */
const formatCurrency = (amount) => `₹${Number(amount).toLocaleString('en-IN')}`;

/**
 * Template for Order Confirmation
 */
const orderConfirmationTemplate = (order, storeName) => {
  const itemsHtml = order.items.map(item => `
    <tr>
      <td>
        <b>${item.productName}</b><br/>
        <span style="font-size:12px;color:#6b7280">${item.variant.size} / ${item.variant.color}</span>
      </td>
      <td class="text-right">${item.quantity}</td>
      <td class="text-right">${formatCurrency(item.total)}</td>
    </tr>
  `).join('');

  const body = `
    <h2>Order Placed!</h2>
    <p>Hi ${order.shippingAddress?.name || 'Customer'},</p>
    <p>Thank you for your order! We've received your request and are getting it ready for shipment. Your order number is <b>#${order.orderNumber}</b>.</p>
    
    <table class="order-table">
      <thead>
        <tr>
          <th>Product</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        ${itemsHtml}
        <tr>
          <td colspan="2" class="text-right summary-row">Subtotal</td>
          <td class="text-right summary-row">${formatCurrency(order.pricing.subtotal)}</td>
        </tr>
        <tr>
          <td colspan="2" class="text-right summary-row">Shipping</td>
          <td class="text-right summary-row">${formatCurrency(order.pricing.shippingCharges)}</td>
        </tr>
        <tr class="total-row">
          <td colspan="2" class="text-right">Total</td>
          <td class="text-right">${formatCurrency(order.pricing.totalAmount)}</td>
        </tr>
      </tbody>
    </table>
    
    <p><b>Shipping Address:</b><br/>
    ${order.shippingAddress.addressLine1}, ${order.shippingAddress.city}, ${order.shippingAddress.state} - ${order.shippingAddress.pincode}</p>
  `;

  return generateEmailHTML({
    title: `Order Confirmation #${order.orderNumber}`,
    preheader: `Thank you for your order from ${storeName}!`,
    body,
    storeName,
    cta: { url: `${process.env.FRONTEND_URL}/account/orders/${order._id}`, text: 'View Order Status' }
  });
};

/**
 * Template for Low Stock Alert (Admin)
 */
const lowStockTemplate = (product, storeName) => {
  const body = `
    <h2 style="color:#dc2626">⚠️ Low Stock Alert</h2>
    <p>Admin, the following product is running low on stock:</p>
    <div style="background-color:#fee2e2; padding:20px; border-radius:8px; margin:20px 0">
      <h3 style="margin-top:0">${product.name}</h3>
      <p><b>SKU:</b> ${product.sku || 'N/A'}<br/>
      <b>Current Stock:</b> <span style="color:#dc2626; font-weight:700">${product.totalStock || 0} units</span></p>
    </div>
    <p>Please restock soon to avoid missing out on sales.</p>
  `;

  return generateEmailHTML({
    title: 'Low Stock Alert!',
    preheader: `Inventory Alert: ${product.name} is low on stock.`,
    body,
    storeName,
    brandColor: '#dc2626',
    cta: { url: `${process.env.FRONTEND_URL}/admin/inventory`, text: 'Manage Inventory' }
  });
};

/**
 * Template for Admin Order Notification
 */
const adminOrderTemplate = (order, storeName) => {
  const body = `
    <h2>🎉 New Order Received</h2>
    <p>A new order has been placed on the store.</p>
    <div style="background-color:#f3f4f6; padding:20px; border-radius:8px; margin:20px 0">
      <p><b>Order:</b> #${order.orderNumber}<br/>
      <b>Customer:</b> ${order.shippingAddress?.name}<br/>
      <b>Amount:</b> ${formatCurrency(order.pricing.totalAmount)}<br/>
      <b>Payment:</b> ${order.paymentMethod.toUpperCase()}</p>
    </div>
  `;

  return generateEmailHTML({
    title: 'New Order Alert',
    preheader: `New order #${order.orderNumber} received!`,
    body,
    storeName,
    cta: { url: `${process.env.FRONTEND_URL}/admin/orders/${order._id}`, text: 'Process Order' }
  });
};

module.exports = {
  orderConfirmationTemplate,
  lowStockTemplate,
  adminOrderTemplate,
  generateEmailHTML
};
