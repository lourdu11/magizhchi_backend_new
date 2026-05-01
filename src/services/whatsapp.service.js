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

const initWhatsApp = async () => {
    const now = Date.now();
    
    // 1. Singleton Lock Check (Prevents multiple processes)
    const existingPid = checkLock();
    if (existingPid) {
        logger.error(`🚨 WhatsApp Conflict: Another instance (PID ${existingPid}) is already controlling the socket.`);
        logger.error('👉 If that process is stuck, kill it manually or delete the .whatsapp.lock file.');
        return;
    }

    // 2. Cooldown check
    if (isInitializing || (now - lastInitTime < 10000)) {
        if (isInitializing) logger.debug('📱 WhatsApp: Already initializing, skipping...');
        return;
    }
    
    isInitializing = true;
    lastInitTime = now;
    createLock();

    // If there's an existing socket, close it first
    if (sock) {
        logger.info('📱 WhatsApp: Ensuring previous socket is closed...');
        try {
            sock.ev.removeAllListeners();
            sock.end();
        } catch (e) {}
        sock = null;
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const sessionPath = path.resolve(__dirname, '../../.whatsapp-session/baileys-auth');
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    logger.info('📱 WhatsApp: Initializing Pure Socket Client (Baileys)...');

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
        browser: ['Magizhchi ERP', 'Chrome', '110.0.0'], // More unique browser name
        syncFullHistory: false, // Don't sync old messages to reduce conflict chance
        markOnlineOnConnect: false, // Don't mark as online immediately
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 60000, // Increase keep-alive
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            logger.info('📱 WhatsApp: [NEW QR CODE] Scan the LATEST link below:');
            qrcode.generate(qr, { small: true });
            
            const qrLink = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
            logger.info(`🔗 LATEST QR LINK: ${qrLink}`);
        }

        if (connection === 'close') {
            const errorCode = lastDisconnect?.error?.output?.statusCode;
            const errorMsg = lastDisconnect?.error?.message || 'Unknown Error';
            
            // If logged out or credentials invalid, clear session to force new QR
            if (errorCode === DisconnectReason.loggedOut || errorCode === 401) {
                logger.warn('🚫 WhatsApp: Session expired or logged out. Clearing session files...');
                const sessionPath = path.resolve(__dirname, '../../.whatsapp-session/baileys-auth');
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                isReady = false;
                isInitializing = false;
                initWhatsApp(); // Restart to get new QR
                return;
            }

            const shouldReconnect = errorCode !== DisconnectReason.loggedOut;
            logger.warn(`⚠️ WhatsApp: Connection closed. Reason: ${errorMsg} (Code: ${errorCode}). Reconnecting: ${shouldReconnect}`);
            
            isReady = false;
            isInitializing = false;
            
            if (shouldReconnect) {
                // If it's a conflict (440, 428), another instance is likely running.
                // We wait much longer to allow the other instance to timeout or close.
                const delay = (errorCode === 440 || errorCode === 428) ? 30000 : 10000;
                
                if (errorCode === 440 || errorCode === 428) {
                    logger.error(`🚨 WhatsApp CONFLICT (Code ${errorCode}): Another instance is active.`);
                    logger.error('👉 Please close ALL other terminal windows and wait for this instance to repair.');
                }

                logger.info(`🔄 WhatsApp: Auto-repair cooldown (${delay/1000}s)...`);
                
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => {
                    initWhatsApp();
                }, delay);
            }
        } else if (connection === 'open') {
            isReady = true;
            isInitializing = false;
            logger.info('✅ WhatsApp Ready: [Socket Connected]');
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
