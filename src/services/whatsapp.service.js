const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const logger = require('../utils/logger');
const Settings = require('../models/Settings');
const WhatsAppSession = require('../models/WhatsAppSession');

let sock = null;
let isReady = false;
let isInitializing = false;
let lastInitTime = 0;
let currentQR = null;
let reconnectTimeout = null;

/**
 * ARCHITECTURE: PURE MONGODB AUTH (NO LOCAL DISK DEPENDENCY)
 * 1. Uses Baileys to connect directly to WhatsApp via WebSockets.
 * 2. Auth state (creds + keys) is stored directly in MongoDB.
 * 3. Works perfectly on Render/Heroku/Cloud without losing session.
 */

const useMongoDBAuthState = async (sessionKey = 'baileys-auth') => {
    const writeData = async (data, key) => {
        try {
            const str = JSON.stringify(data, BufferJSON.replacer);
            await WhatsAppSession.findOneAndUpdate(
                { key: `${sessionKey}-${key}` },
                { data: str },
                { upsert: true }
            );
        } catch (err) {
            logger.error(`❌ WhatsApp: Failed to write ${key} to DB:`, err.message);
        }
    };

    const readData = async (key) => {
        try {
            const res = await WhatsAppSession.findOne({ key: `${sessionKey}-${key}` });
            return res ? JSON.parse(res.data, BufferJSON.reviver) : null;
        } catch (err) {
            logger.error(`❌ WhatsApp: Failed to read ${key} from DB:`, err.message);
            return null;
        }
    };

    const removeData = async (key) => {
        try {
            await WhatsAppSession.deleteOne({ key: `${sessionKey}-${key}` });
        } catch (err) {
            logger.error(`❌ WhatsApp: Failed to delete ${key} from DB:`, err.message);
        }
    };

    // Load initial creds
    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = value; // Already handled by BufferJSON
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
};

const clearSessionFromDb = async (sessionKey = 'baileys-auth') => {
    try {
        await WhatsAppSession.deleteMany({ key: { $regex: new RegExp(`^${sessionKey}-`) } });
        logger.info('🗑️ WhatsApp: Remote session cleared from MongoDB');
    } catch (err) {
        logger.error('❌ WhatsApp: Failed to clear session from DB:', err.message);
    }
};

/**
 * ARCHITECTURE: PURE SOCKET MODE (NO BROWSER)
 * 1. Uses Baileys to connect directly to WhatsApp via WebSockets.
 * 2. No Chrome, No Puppeteer, No memory-heavy processes.
 * 3. Session stored in .whatsapp-session/baileys-auth.
 */

const getAdminSettings = async () => {
  try {
    const settings = await Settings.findOne();
    return {
      adminPhone: settings?.notifications?.whatsapp?.adminPhone || process.env.STORE_PHONE,
      storeName: settings?.storeName || 'Magizhchi Garments'
    };
  } catch (err) {
    return { adminPhone: process.env.STORE_PHONE, storeName: 'Magizhchi Garments' };
  }
};

const closeWhatsApp = async () => {
    if (sock) {
        try {
            logger.info('📱 WhatsApp: Closing socket...');
            sock.ev.removeAllListeners();
            sock.end();
            sock = null;
            isReady = false;
        } catch (e) {}
    }
    // Remote auth doesn't use local locks
};


const initWhatsApp = async () => {
    const now = Date.now();
    
    // 1. Singleton Check (Basic cooldown/lock)
    if (isInitializing || (now - lastInitTime < 10000)) return;
    
    isInitializing = true;
    lastInitTime = now;

    // ─── ZOMBIE SOCKET KILLER ───
    // Before starting a new connection, ensure any old socket is dead.
    // This prevents "Conflict (440)" errors where two sockets fight for the same session.
    if (sock) {
        try {
            logger.info('📱 WhatsApp: Cleaning up previous socket instance...');
            sock.ev.removeAllListeners();
            sock.end();
            sock = null;
        } catch (e) {
            logger.warn('⚠️ WhatsApp: Cleanup of old socket failed (ignorable):', e.message);
        }
    }

    logger.info('📱 WhatsApp: Initializing with MongoDB Auth...');

    const { state, saveCreds } = await useMongoDBAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: [`Magizhchi ERP ${Math.random().toString(36).substring(7)}`, 'Chrome', '110.0.0'],
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
            logger.info(`🔗 WhatsApp QR: ${qrLink}`);
        }

        if (connection === 'close') {
            const errorCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || '';
            const isBadSession = errorCode === 401 || errorMsg.includes('Bad MAC') || errorMsg.includes('encryption');
            
            logger.info(`📱 WhatsApp: Connection closed (Code: ${errorCode}, Msg: ${errorMsg})`);
            
            const shouldReconnect = errorCode !== DisconnectReason.loggedOut && !isBadSession;
            
            isReady = false;
            isInitializing = false;
            
            if (isBadSession) {
                logger.error('🚨 WhatsApp: Corrupt session detected. Clearing from MongoDB...');
                await clearSessionFromDb();
                setTimeout(() => initWhatsApp(), 5000);
            } else if (shouldReconnect) {
                logger.info('🔄 WhatsApp: Attempting to reconnect in 10s...');
                setTimeout(() => initWhatsApp(), 10000);
            } else {
                logger.warn('🚫 WhatsApp: Logged out or terminal error. Not reconnecting.');
                await clearSessionFromDb();
            }
        } else if (connection === 'open') {
            isReady = true;
            isInitializing = false;
            logger.info('✅ WhatsApp Connected (Cloud Session Active)');
        }
    });

    return sock;
};

const sendMessage = async (phone, message, options = {}, retries = 3) => {
    const cleanPhone = phone.replace(/\D/g, '');
    const withCountry = cleanPhone.startsWith('91') ? cleanPhone : `91${cleanPhone}`;
    const jid = `${withCountry}@s.whatsapp.net`;
    const { image } = options;

    for (let i = 0; i < retries; i++) {
        try {
            if (!isReady || !sock) {
                // If already initializing, don't trigger again, just wait
                if (!isInitializing) await initWhatsApp();
                
                // Wait for connection to be ready (increased poll: 30s)
                logger.info(`⏳ WhatsApp: Waiting for connection (Attempt ${i + 1})...`);
                for (let j = 0; j < 30; j++) {
                    if (isReady) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!isReady) throw new Error('WhatsApp socket not ready after 30s');
            }

            if (image) {
                await sock.sendMessage(jid, { image: { url: image }, caption: message });
            } else {
                await sock.sendMessage(jid, { text: message });
            }
            
            logger.info(`✅ WhatsApp message ${image ? 'with image ' : ''}sent to +${withCountry}`);
            return true;
        } catch (err) {
            logger.warn(`⚠️ WhatsApp Send Attempt ${i + 1} failed: ${err.message}`);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 3000)); // Increase wait between retries
        }
    }
};

const sendContactMessageNotificationToAdmin = async (contact) => {
    const { adminPhone } = await getAdminSettings();
    if (!adminPhone) return;

    const msg = `📩 *NEW CONTACT MESSAGE*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `👤 *Name:* ${contact.name}\n` +
                `📞 *Phone:* ${contact.phone}\n` +
                `📧 *Email:* ${contact.email || 'N/A'}\n` +
                `🏷️ *Subject:* ${contact.subject || 'N/A'}\n\n` +
                `💬 *Message:*\n_${contact.message}_\n\n` +
                `──────────────────\n` +
                `*Please respond promptly.*`;
                
    return await sendMessage(adminPhone, msg);
};

const sendOrderNotificationToAdmin = async (order) => {
    const { adminPhone } = await getAdminSettings();
    if (!adminPhone) return;

    const itemsSummary = order.items.map(item => `- ${item.productName} (${item.variant.size}/${item.variant.color}) x${item.quantity}`).join('\n');

    const msg = `🛍️ *NEW ORDER RECEIVED!*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `📦 *Order ID:* #${order.orderNumber}\n` +
                `👤 *Customer:* ${order.shippingAddress.name}\n` +
                `📞 *Phone:* ${order.shippingAddress.phone}\n` +
                `💰 *Total:* ₹${order.pricing.totalAmount.toLocaleString('en-IN')}\n` +
                `💳 *Payment:* ${order.paymentMethod.toUpperCase()}\n\n` +
                `🛒 *Items:*\n${itemsSummary}\n\n` +
                `──────────────────\n` +
                `*Check the Admin Dashboard for details.*`;

    return await sendMessage(adminPhone, msg);
};

const sendOrderCancellationNotificationToAdmin = async (order, reason) => {
    const { adminPhone } = await getAdminSettings();
    if (!adminPhone) return;

    const msg = `🚫 *ORDER CANCELLED*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `📦 *Order ID:* #${order.orderNumber}\n` +
                `👤 *Customer:* ${order.shippingAddress.name}\n` +
                `💰 *Total:* ₹${order.pricing.totalAmount.toLocaleString('en-IN')}\n\n` +
                `⚠️ *Reason:* ${reason || 'Not provided'}\n\n` +
                `──────────────────`;

    return await sendMessage(adminPhone, msg);
};

const sendProductNotificationToAdmin = async (product, action = 'updated') => {
    const { adminPhone } = await getAdminSettings();
    if (!adminPhone) return;

    const emoji = action === 'created' ? '✨' : '📝';
    const title = action === 'created' ? 'NEW PRODUCT CREATED' : 'PRODUCT UPDATED';

    const msg = `${emoji} *${title}*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `🏷️ *Name:* ${product.name}\n` +
                `📦 *SKU:* ${product.sku}\n` +
                `💰 *Price:* ₹${product.sellingPrice.toLocaleString('en-IN')}\n` +
                `🗂️ *Category:* ${product.category?.name || 'N/A'}\n\n` +
                `──────────────────\n` +
                `*Check Admin Dashboard for full details.*`;

    return await sendMessage(adminPhone, msg);
};

const sendStockAlertToAdmin = async (item, currentStock) => {
    const { adminPhone } = await getAdminSettings();
    if (!adminPhone) return;

    const msg = `🚨 *LOW STOCK ALERT*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `📦 *Product:* ${item.productName}\n` +
                `🎨 *Variant:* ${item.color} / ${item.size}\n` +
                `📉 *Current Stock:* *${currentStock}*\n` +
                `⚠️ *Threshold:* ${item.lowStockThreshold || 5}\n\n` +
                `──────────────────\n` +
                `*Please restock this item soon.*`;

    return await sendMessage(adminPhone, msg);
};

const sendWhatsAppOTP = async (phone, otp) => {
    const { storeName } = await getAdminSettings();
    const msg = `🔐 *SECURE OTP*\n` +
                `*${storeName.toUpperCase()}*\n` +
                `──────────────────\n\n` +
                `Your verification code is:\n` +
                `*${otp}*\n\n` +
                `Valid for 10 minutes. Please do not share this code with anyone.\n\n` +
                `──────────────────`;
    return await sendMessage(phone, msg);
};

const sendWhatsAppNotification = async (phone, message) => {
    const { storeName } = await getAdminSettings();
    const msg = `📢 *OFFICIAL NOTIFICATION*\n` +
                `*${storeName}*\n` +
                `──────────────────\n\n` +
                `${message}\n\n` +
                `──────────────────`;
    return await sendMessage(phone, msg);
};

const sendOrderReceiptToCustomer = async (phone, order, type = 'online') => {
    const { storeName } = await getAdminSettings();
    const isOnline = type === 'online';
    const orderNo = isOnline ? order.orderNumber : order.billNumber;
    const items = order.items.map(item => 
        `• ${item.productName} (${item.variant.size}/${item.variant.color})\n` +
        `  ${item.quantity} x ₹${item.price.toLocaleString('en-IN')} = ₹${item.total.toLocaleString('en-IN')}`
    ).join('\n');

    const discount = order.pricing.discount || order.pricing.couponDiscount || 0;
    const totalAmount = order.pricing.totalAmount;

    const msg = `🧾 *OFFICIAL RECEIPT*\n` +
                `*${storeName.toUpperCase()}*\n` +
                `──────────────────\n\n` +
                `Greetings from Magizhchi! Your ${isOnline ? 'order' : 'bill'} is finalized.\n\n` +
                `🆔 *${isOnline ? 'Order' : 'Bill'} #:* ${orderNo}\n` +
                `📅 *Date:* ${new Date(isOnline ? order.createdAt : order.billDate).toLocaleDateString('en-IN')}\n\n` +
                `🛒 *Items:*\n${items}\n\n` +
                `──────────────────\n` +
                `💵 *Subtotal:* ₹${order.pricing.subtotal.toLocaleString('en-IN')}\n` +
                (discount > 0 ? `🧧 *Discount:* -₹${discount.toLocaleString('en-IN')}\n` : '') +
                (isOnline && order.pricing.shippingCharges > 0 ? `🚚 *Shipping:* ₹${order.pricing.shippingCharges}\n` : '') +
                `✨ *Total Amount:* ₹${totalAmount.toLocaleString('en-IN')}\n` +
                `──────────────────\n\n` +
                `👤 *Customer:* ${isOnline ? order.shippingAddress.name : order.customerDetails.name}\n` +
                `💳 *Paid via:* ${order.paymentMethod.toUpperCase()}\n\n` +
                `Thank you for shopping with us! 🙏`;

    const mainImage = isOnline 
        ? (order.items[0]?.productImage || order.items[0]?.productId?.images?.[0])
        : (order.items[0]?.productId?.images?.[0] || order.items[0]?.productImage);

    return await sendMessage(phone, msg, { image: mainImage });
};

process.on('exit', () => {});
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

const getStatus = () => ({
    ready: isReady,
    initializing: isInitializing,
    qr: currentQR ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(currentQR)}&size=300x300` : null
});

module.exports = {
    initWhatsApp,
    sendMessage,
    sendWhatsAppOTP,
    sendWhatsAppNotification,
    sendOrderReceiptToCustomer,
    sendOrderNotificationToAdmin,
    sendOrderCancellationNotificationToAdmin,
    sendContactMessageNotificationToAdmin,
    sendProductNotificationToAdmin,
    sendStockAlertToAdmin,
    isReady: () => isReady,
    getQRLink: () => currentQR ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(currentQR)}&size=300x300` : null,
    closeWhatsApp,
    getStatus
};
