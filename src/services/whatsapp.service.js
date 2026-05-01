const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore 
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

const LOCK_FILE = path.resolve(__dirname, '../../.whatsapp.lock');

const checkLock = () => {
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (pid && pid !== process.pid) {
                try {
                    process.kill(pid, 0); // Check if process exists
                    return pid;
                } catch (e) {
                    // Process not running, stale lock
                    return null;
                }
            }
        } catch (e) {
            return null;
        }
    }
    return null;
};

const createLock = () => {
    fs.writeFileSync(LOCK_FILE, process.pid.toString(), 'utf8');
};

const removeLock = () => {
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
            if (pid === process.pid) {
                fs.unlinkSync(LOCK_FILE);
            }
        } catch (e) {}
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
    removeLock();
};

const saveSessionToDb = async () => {
    try {
        const sessionPath = path.resolve(__dirname, '../../.whatsapp-session/baileys-auth');
        if (!fs.existsSync(sessionPath)) return;

        const files = fs.readdirSync(sessionPath);
        const sessionData = {};

        for (const file of files) {
            if (file.endsWith('.json')) {
                const content = fs.readFileSync(path.join(sessionPath, file), 'utf8');
                sessionData[file] = content;
            }
        }

        await WhatsAppSession.findOneAndUpdate(
            { key: 'baileys-auth' },
            { data: JSON.stringify(sessionData) },
            { upsert: true, new: true }
        );
        logger.debug('💾 WhatsApp: Session synced to MongoDB');
    } catch (err) {
        logger.error('❌ WhatsApp: Failed to sync session to MongoDB:', err.message);
    }
};

const restoreSessionFromDb = async () => {
    try {
        const sessionPath = path.resolve(__dirname, '../../.whatsapp-session/baileys-auth');
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        const session = await WhatsAppSession.findOne({ key: 'baileys-auth' });
        if (!session) {
            logger.info('📱 WhatsApp: No existing session found in MongoDB');
            return false;
        }

        const sessionData = JSON.parse(session.data);
        for (const [file, content] of Object.entries(sessionData)) {
            fs.writeFileSync(path.join(sessionPath, file), content, 'utf8');
        }
        logger.info('✅ WhatsApp: Session restored from MongoDB');
        return true;
    } catch (err) {
        logger.error('❌ WhatsApp: Failed to restore session from MongoDB:', err.message);
        return false;
    }
};

const initWhatsApp = async () => {
    const now = Date.now();
    
    // 1. Singleton Lock Check
    const existingPid = checkLock();
    if (existingPid) {
        logger.warn(`📱 WhatsApp: Instance already running (PID ${existingPid})`);
        return;
    }

    // 2. Cooldown check
    if (isInitializing || (now - lastInitTime < 10000)) return;
    
    isInitializing = true;
    lastInitTime = now;
    createLock();

    // 3. Restore from MongoDB before starting
    await restoreSessionFromDb();

    const sessionPath = path.resolve(__dirname, '../../.whatsapp-session/baileys-auth');
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Magizhchi ERP', 'Chrome', '110.0.0'],
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSessionToDb(); // Sync to MongoDB whenever creds change
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
            logger.info(`🔗 WhatsApp QR: ${qrLink}`);
        }

        if (connection === 'close') {
            const errorCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = errorCode !== DisconnectReason.loggedOut;
            
            isReady = false;
            isInitializing = false;
            
            if (shouldReconnect) {
                setTimeout(() => initWhatsApp(), 10000);
            } else {
                // Logged out: Clear everything
                WhatsAppSession.deleteOne({ key: 'baileys-auth' }).catch(() => {});
                if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
            }
        } else if (connection === 'open') {
            isReady = true;
            isInitializing = false;
            logger.info('✅ WhatsApp Connected');
            saveSessionToDb(); // Initial sync on success
        }
    });

    return sock;
};

const sendMessage = async (phone, message, retries = 3) => {
    const cleanPhone = phone.replace(/\D/g, '');
    const withCountry = cleanPhone.startsWith('91') ? cleanPhone : `91${cleanPhone}`;
    const jid = `${withCountry}@s.whatsapp.net`;

    for (let i = 0; i < retries; i++) {
        try {
            if (!isReady || !sock) {
                await initWhatsApp();
                // Wait for connection to be ready (short poll)
                for (let j = 0; j < 10; j++) {
                    if (isReady) break;
                    await new Promise(r => setTimeout(r, 1000));
                }
                if (!isReady) throw new Error('WhatsApp socket not ready');
            }

            await sock.sendMessage(jid, { text: message });
            logger.info(`✅ WhatsApp message sent to +${withCountry}`);
            return true;
        } catch (err) {
            logger.warn(`⚠️ WhatsApp Send Attempt ${i + 1} failed: ${err.message}`);
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, 2000));
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

process.on('exit', removeLock);
process.on('SIGINT', removeLock);
process.on('SIGTERM', removeLock);

module.exports = {
    initWhatsApp,
    sendMessage,
    sendWhatsAppOTP,
    sendWhatsAppNotification,
    sendOrderNotificationToAdmin,
    sendOrderCancellationNotificationToAdmin,
    sendContactMessageNotificationToAdmin,
    sendProductNotificationToAdmin,
    sendStockAlertToAdmin,
    isReady: () => isReady,
    getQRLink: () => currentQR ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(currentQR)}&size=300x300` : null,
    closeWhatsApp
};
