const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore,
    initAuthCreds,
    BufferJSON
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const logger = require('../utils/logger');
const Settings = require('../models/Settings');
const WhatsAppSession = require('../models/WhatsAppSession');

// Suppress libsignal noisy console logs
const originalConsoleLog = console.log;
console.log = function (...args) {
    if (typeof args[0] === 'string' && args[0].includes('Decrypted message with closed session')) {
        return;
    }
    originalConsoleLog.apply(console, args);
};

const originalConsoleError = console.error;
console.error = function (...args) {
    if (typeof args[0] === 'string' && args[0].includes('Decrypted message with closed session')) {
        return;
    }
    originalConsoleError.apply(console, args);
};

let sock = null;
let isReady = false;
let isInitializing = false;
let lastInitTime = 0;
let currentQR = null;
let currentQRDataUrl = null;
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
                            if (value) {
                                if (type === 'app-state-sync-key') {
                                    value = value; // Already handled by BufferJSON
                                }
                                data[id] = value;
                            }
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
    const rawPhone = settings?.notifications?.whatsapp?.adminPhone || process.env.STORE_PHONE || '';
    const adminPhones = rawPhone.split(/[\s,;]+/)
      .map(p => p.trim())
      .filter(p => p.length >= 10);
    return {
      adminPhones: adminPhones.length > 0 ? adminPhones : [process.env.STORE_PHONE].filter(Boolean),
      storeName: settings?.storeName || 'Magizhchi Garments'
    };
  } catch (err) {
    return { adminPhones: [process.env.STORE_PHONE].filter(Boolean), storeName: 'Magizhchi Garments' };
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
    
    // 1. Singleton Check with 45s Watchdog
    if (isInitializing && (now - lastInitTime < 45000)) {
        logger.info('📱 WhatsApp: Already initializing, skipping...');
        return;
    }
    if (!isInitializing && (now - lastInitTime < 10000)) {
        logger.info('📱 WhatsApp: Cooldown active, skipping...');
        return;
    }
    
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
            currentQRDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 1 });

            // ── Log scannable QR URL to Render logs ──────────────────────
            // Admin can open this URL in any browser and scan with WhatsApp
            const encodedQR = encodeURIComponent(qr);
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodedQR}&size=300x300`;
            logger.info('');
            logger.info('╔══════════════════════════════════════════════════════════╗');
            logger.info('║         📱 WHATSAPP QR CODE — SCAN TO CONNECT           ║');
            logger.info('║                                                          ║');
            logger.info('║  Open this URL in your browser and scan with WhatsApp:  ║');
            logger.info(`║  ${qrImageUrl.substring(0, 56).padEnd(56)} ║`);
            logger.info('║  (Full URL below)                                        ║');
            logger.info('╚══════════════════════════════════════════════════════════╝');
            logger.info(`📱 WhatsApp QR: ${qrImageUrl}`);
            logger.info('');
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

    // ─── MESSAGE ACKNOWLEDGEMENT TRACKER ───
    sock.ev.on('messages.update', async (updates) => {
        const BroadcastLog = require('../models/BroadcastLog');
        const Broadcast = require('../models/Broadcast');
        
        for (const update of updates) {
            const { key, update: msgUpdate } = update;
            // status 3 = delivered, 4 = read (blue checks)
            if (msgUpdate.status === 3 || msgUpdate.status === 4) {
                const log = await BroadcastLog.findOneAndUpdate(
                    { messageId: key.id, status: { $ne: 'failed' } },
                    { status: 'delivered', deliveredAt: new Date() }
                );

                if (log && log.status !== 'delivered') {
                    // Update the master broadcast stats
                    await Broadcast.findByIdAndUpdate(log.broadcastId, {
                        $inc: { 'stats.delivered': 1 }
                    });
                }
            }
        }
    });

    return sock;
};

const sendMessage = async (phone, message, options = {}, retries = 2) => {
    const cleanPhone = phone.replace(/\D/g, '');
    const withCountry = cleanPhone.startsWith('91') ? cleanPhone : `91${cleanPhone}`;
    const jid = `${withCountry}@s.whatsapp.net`;
    const { image } = options;

    for (let i = 0; i < retries; i++) {
        try {
            if (!isReady || !sock) {
                // If already initializing, don't trigger again, just wait
                if (!isInitializing) await initWhatsApp();
                
                // Wait up to 8s for connection — fail fast so email fallback can fire
                logger.info(`⏳ WhatsApp: Waiting for connection (Attempt ${i + 1})...`);
                for (let j = 0; j < 8; j++) {
                    if (isReady) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!isReady) throw new Error('WhatsApp socket not ready after 8s');
            }

            let result;
            if (image) {
                result = await sock.sendMessage(jid, { 
                    image: { url: image }, 
                    caption: message 
                });
            } else {
                result = await sock.sendMessage(jid, { text: message });
            }
            logger.info(`✅ WhatsApp message ${image ? 'with image ' : ''}sent to +${withCountry}`);
            return result;
        } catch (err) {
            logger.warn(`⚠️ WhatsApp Send Attempt ${i + 1} failed: ${err.message}`);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 2000)); // Wait 2s between retries
        }
    }
};

const sendContactMessageNotificationToAdmin = async (contact) => {
    const { adminPhones } = await getAdminSettings();
    if (!adminPhones || adminPhones.length === 0) return;

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
                
    let result;
    for (const phone of adminPhones) {
        result = await sendMessage(phone, msg);
    }
    return result;
};

const sendOrderNotificationToAdmin = async (order) => {
    const { adminPhones } = await getAdminSettings();
    if (!adminPhones || adminPhones.length === 0) return;

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

    let result;
    for (const phone of adminPhones) {
        result = await sendMessage(phone, msg);
    }
    return result;
};

const sendOrderCancellationNotificationToAdmin = async (order, reason) => {
    const { adminPhones } = await getAdminSettings();
    if (!adminPhones || adminPhones.length === 0) return;

    const msg = `🚫 *ORDER CANCELLED*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `📦 *Order ID:* #${order.orderNumber}\n` +
                `👤 *Customer:* ${order.shippingAddress.name}\n` +
                `💰 *Total:* ₹${order.pricing.totalAmount.toLocaleString('en-IN')}\n\n` +
                `⚠️ *Reason:* ${reason || 'Not provided'}\n\n` +
                `──────────────────`;

    let result;
    for (const phone of adminPhones) {
        result = await sendMessage(phone, msg);
    }
    return result;
};

const sendProductNotificationToAdmin = async (product, action = 'updated') => {
    const { adminPhones } = await getAdminSettings();
    if (!adminPhones || adminPhones.length === 0) return;

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

    let result;
    for (const phone of adminPhones) {
        result = await sendMessage(phone, msg);
    }
    return result;
};

const sendStockAlertToAdmin = async (item, currentStock) => {
    const { adminPhones } = await getAdminSettings();
    if (!adminPhones || adminPhones.length === 0) return;

    const msg = `🚨 *LOW STOCK ALERT*\n` +
                `*Magizhchi Garments*\n` +
                `──────────────────\n\n` +
                `📦 *Product:* ${item.productName}\n` +
                `🎨 *Variant:* ${item.color} / ${item.size}\n` +
                `📉 *Current Stock:* *${currentStock}*\n` +
                `⚠️ *Threshold:* ${item.lowStockThreshold || 5}\n\n` +
                `──────────────────\n` +
                `*Please restock this item soon.*`;

    let result;
    for (const phone of adminPhones) {
        result = await sendMessage(phone, msg);
    }
    return result;
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
    qr: currentQR ? currentQRDataUrl : null
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
    closeWhatsApp,
    clearSessionFromDb,
    getStatus,
    isRegistered: async (phone) => {
        if (!sock || !isReady) return false;
        try {
            // Standardize phone format for check
            const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
            const [result] = await sock.onWhatsApp(jid);
            return result?.exists || false;
        } catch (err) {
            return false;
        }
    }
};
