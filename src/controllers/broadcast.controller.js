const mongoose = require('mongoose');
const Broadcast = require('../models/Broadcast');
const BroadcastLog = require('../models/BroadcastLog');
const MessageTemplate = require('../models/MessageTemplate');
const User = require('../models/User');
const Bill = require('../models/Bill');
const whatsappService = require('../services/whatsapp.service');
const logger = require('../utils/logger');

const MESSAGE_DELAY = 5000; 

// Helper to validate real phone numbers
const isRealPhone = (p) => {
    if (!p) return false;
    const clean = p.replace(/\D/g, '');
    if (clean.length < 10) return false;
    if (/^(\d)\1+$/.test(clean)) return false; 
    
    // Reject suspicious patterns (e.g. 0000000001, 1112111111)
    const uniqueDigits = new Set(clean.split('')).size;
    if (uniqueDigits < 3) return false; 
    if (clean.startsWith('000')) return false; 

    if (['1234567890', '9876543210', '0123456789'].includes(clean)) return false;
    return true;
};

/**
 * Get all potential recipients (Customers/Staff)
 */
exports.getBroadcastCustomers = async (req, res) => {
    try {
        const { search, segment } = req.query;
        
        // 1. Fetch Online Customers
        const userQuery = { phone: { $exists: true, $ne: '' }, role: 'user', isDeleted: { $ne: true } };
        if (search) {
            userQuery.$or = [
                { name: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } }
            ];
        }
        const onlineUsers = await User.find(userQuery).select('name phone createdAt').lean();
        
        // 2. Fetch Offline Customer Data & Analysis
        const billQuery = { 'customerDetails.phone': { $exists: true, $ne: '' } };
        const offlineBills = await Bill.find(billQuery).select('customerDetails pricing createdAt').lean();
        
        const customerMap = new Map();
        
        // Process Offline first
        offlineBills.forEach(b => {
            const phone = b.customerDetails.phone.replace(/\D/g, '');
            if (!isRealPhone(phone)) return; // SKIP FAKE
            
            const existing = customerMap.get(phone) || {
                id: null,
                name: b.customerDetails.name || 'Customer',
                phone: phone,
                type: 'offline',
                totalSpent: 0,
                billCount: 0,
                lastPurchase: b.createdAt
            };
            
            existing.totalSpent += (b.pricing?.totalAmount || 0) / 100;
            existing.billCount += 1;
            if (new Date(b.createdAt) > new Date(existing.lastPurchase)) {
                existing.lastPurchase = b.createdAt;
            }
            
            customerMap.set(phone, existing);
        });

        // Overlay Online
        onlineUsers.forEach(u => {
            const phone = u.phone.replace(/\D/g, '');
            if (!isRealPhone(phone)) return; // SKIP FAKE
            
            const existing = customerMap.get(phone);
            customerMap.set(phone, {
                id: u._id,
                name: u.name,
                phone: phone,
                type: 'online',
                totalSpent: existing ? existing.totalSpent : 0,
                billCount: existing ? existing.billCount : 0,
                lastPurchase: existing ? existing.lastPurchase : u.createdAt
            });
        });

        let users = Array.from(customerMap.values());

        // 3. APPLY SEGMENTATION
        if (segment === 'big_spenders') {
            users = users.filter(u => u.totalSpent > 5000);
        } else if (segment === 'regular_customers') {
            users = users.filter(u => u.billCount >= 3);
        } else if (segment === 'inactive') {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            users = users.filter(u => new Date(u.lastPurchase) < thirtyDaysAgo);
        } else if (segment === 'offline_only') {
            users = users.filter(u => u.type === 'offline');
        } else if (segment === 'online_only') {
            users = users.filter(u => u.type === 'online');
        }

        if (search) {
            users = users.filter(u => 
                u.name.toLowerCase().includes(search.toLowerCase()) || 
                u.phone.includes(search)
            );
        }

        users.sort((a, b) => b.totalSpent - a.totalSpent); // Sort by highest spenders first

        res.status(200).json({ success: true, count: users.length, users });
    } catch (err) {
        logger.error('Error fetching broadcast customers:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Create and Start Broadcast
 */
exports.createBroadcast = async (req, res) => {
    try {
        const { title, message, mediaUrl, mediaUrls, mediaType, recipients } = req.body;

        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ success: false, message: 'No recipients selected' });
        }

        // Deduplicate and Validate Real Phone Numbers
        const uniqueRecipientsMap = new Map();
        recipients.forEach(r => {
            const phone = r.phone?.replace(/\D/g, '');
            if (isRealPhone(phone) && !uniqueRecipientsMap.has(phone)) {
                uniqueRecipientsMap.set(phone, r);
            }
        });

        const uniqueRecipients = Array.from(uniqueRecipientsMap.values());

        const broadcast = await Broadcast.create({
            title,
            message,
            mediaUrl,
            mediaUrls: Array.isArray(mediaUrls) ? mediaUrls : (mediaUrl ? [mediaUrl] : []),
            mediaType: mediaType || 'none',
            totalRecipients: uniqueRecipients.length,
            stats: { pending: uniqueRecipients.length, sent: 0, delivered: 0, failed: 0 },
            status: 'processing',
            sender: req.user?._id || req.user?.id
        });

        // Create logs for all unique recipients
        const logs = uniqueRecipients.map(r => ({
            broadcastId: broadcast._id,
            customerId: (r.id && mongoose.Types.ObjectId.isValid(r.id)) ? r.id : null,
            customerName: r.name || 'Customer',
            phone: r.phone.replace(/\D/g, ''), // Store normalized phone
            status: 'pending'
        }));

        // Validate individual logs to prevent insertMany failure
        const validLogs = logs.filter(l => l.phone && l.customerName);
        if (validLogs.length === 0) {
            await Broadcast.findByIdAndDelete(broadcast._id);
            return res.status(400).json({ success: false, message: 'All recipients had invalid data' });
        }

        await BroadcastLog.insertMany(validLogs);

        // Update broadcast total based on actual valid logs
        if (validLogs.length !== uniqueRecipients.length) {
            await Broadcast.findByIdAndUpdate(broadcast._id, { 
                totalRecipients: validLogs.length,
                'stats.pending': validLogs.length 
            });
        }

        // Start processing in background
        processBroadcast(broadcast._id, message, mediaUrl, mediaUrls, mediaType).catch(e => logger.error('BG Broadcast Error:', e));

        res.status(201).json({ success: true, broadcastId: broadcast._id, message: `Broadcast started for ${validLogs.length} recipients` });
    } catch (err) {
        logger.error('Error creating broadcast:', err);
        if (err.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: 'Validation Error', errors: err.errors });
        }
        res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
};

/**
 * Background Processor for Broadcast (FIX C2)
 * Uses a cursor to avoid memory pressure and allows for easy resumption
 */
async function processBroadcast(broadcastId, baseMessage, mediaUrl, mediaUrls, mediaType) {
    try {
        // 1. Mark as processing if not already
        await Broadcast.findByIdAndUpdate(broadcastId, { status: 'processing' });

        // 2. Use cursor to process logs one by one (Memory Efficient)
        const cursor = BroadcastLog.find({ broadcastId, status: 'pending' }).cursor();
        
        for (let log = await cursor.next(); log != null; log = await cursor.next()) {
            try {
                // Check if broadcast was cancelled/paused (optional future feature)
                const currentBroadcast = await Broadcast.findById(broadcastId).select('status');
                if (!currentBroadcast || currentBroadcast.status !== 'processing') break;

                const personalizedMessage = baseMessage.replace(/{{name}}/g, log.customerName || 'Customer');
                
                // WhatsApp presence check
                const isRegistered = await whatsappService.isRegistered(log.phone);
                if (!isRegistered) throw new Error('Number not registered on WhatsApp');

                const urlsToUse = Array.isArray(mediaUrls) && mediaUrls.length > 0 ? mediaUrls : (mediaUrl ? [mediaUrl] : []);
                let result;

                if (urlsToUse.length > 0 && mediaType === 'image') {
                    // Send all images except the last one WITHOUT caption
                    for (let i = 0; i < urlsToUse.length - 1; i++) {
                        await whatsappService.sendMessage(log.phone, '', { image: urlsToUse[i] });
                        await new Promise(resolve => setTimeout(resolve, 800)); // small delay between images
                    }
                    // Send the last image WITH caption
                    result = await whatsappService.sendMessage(log.phone, personalizedMessage, { image: urlsToUse[urlsToUse.length - 1] });
                } else {
                    // Text only or other media
                    const options = {};
                    if (mediaUrl && mediaType !== 'image') options[mediaType] = mediaUrl; // fallback
                    result = await whatsappService.sendMessage(log.phone, personalizedMessage, options);
                }
                
                log.status = 'sent';
                log.messageId = result?.key?.id;
                log.sentAt = new Date();
                await log.save();

                await Broadcast.findByIdAndUpdate(broadcastId, {
                    $inc: { 'stats.sent': 1, 'stats.pending': -1 }
                });

            } catch (err) {
                logger.error(`Broadcast failed for ${log.phone}:`, err.message);
                log.status = 'failed';
                log.error = err.message;
                await log.save();

                await Broadcast.findByIdAndUpdate(broadcastId, {
                    $inc: { 'stats.failed': 1, 'stats.pending': -1 }
                });
            }
            
            // Non-blocking delay to respect WhatsApp limits and event loop
            await new Promise(resolve => setTimeout(resolve, MESSAGE_DELAY));
        }

        // 🚀 FINAL RECONCILIATION: Ensure stats are 100% accurate based on logs
        const stats = await BroadcastLog.aggregate([
            { $match: { broadcastId: new mongoose.Types.ObjectId(broadcastId) } },
            { $group: {
                _id: "$status",
                count: { $sum: 1 }
            }}
        ]);

        const statsMap = { sent: 0, delivered: 0, failed: 0, pending: 0 };
        stats.forEach(s => { statsMap[s._id] = s.count; });

        const finalStatus = statsMap.pending > 0 ? 'processing' : (statsMap.failed === (statsMap.sent + statsMap.delivered + statsMap.failed) && statsMap.sent === 0 && statsMap.delivered === 0 ? 'failed' : 'completed');
        
        await Broadcast.findByIdAndUpdate(broadcastId, { 
            status: finalStatus,
            'stats.sent': statsMap.sent,
            'stats.delivered': statsMap.delivered,
            'stats.failed': statsMap.failed,
            'stats.pending': statsMap.pending
        });
        
    } catch (globalErr) {
        logger.error('Fatal Broadcast Error:', globalErr);
        await Broadcast.findByIdAndUpdate(broadcastId, { status: 'failed' });
    }
}

/**
 * Get Broadcast History
 */
exports.getBroadcastHistory = async (req, res) => {
    try {
        const broadcasts = await Broadcast.find()
            .populate('sender', 'name')
            .sort({ createdAt: -1 });
        res.status(200).json({ success: true, broadcasts });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Get Specific Broadcast Details & Logs
 */
exports.getBroadcastDetails = async (req, res) => {
    try {
        const broadcast = await Broadcast.findById(req.params.id).populate('sender', 'name');
        if (!broadcast) return res.status(404).json({ success: false, message: 'Not found' });

        const logs = await BroadcastLog.find({ broadcastId: req.params.id })
            .populate('customerId', 'name phone')
            .sort({ createdAt: 1 });

        res.status(200).json({ success: true, broadcast, logs });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Template Management
 */
exports.getTemplates = async (req, res) => {
    try {
        const templates = await MessageTemplate.find().sort({ name: 1 });
        res.status(200).json({ success: true, templates });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.createTemplate = async (req, res) => {
    try {
        const template = await MessageTemplate.create({ ...req.body, createdBy: req.user.id });
        res.status(201).json({ success: true, template });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.updateTemplate = async (req, res) => {
    try {
        const template = await MessageTemplate.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.status(200).json({ success: true, template });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.deleteTemplate = async (req, res) => {
    try {
        await MessageTemplate.findByIdAndDelete(req.params.id);
        res.status(200).json({ success: true, message: 'Template deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Self-Healing: Resume interrupted broadcasts on server start
exports.resumeInterruptedBroadcasts = async () => {
    try {
        const stuckBroadcasts = await Broadcast.find({ status: 'processing' });
        for (const b of stuckBroadcasts) {
            logger.info(`Resuming interrupted broadcast: ${b.title}`);
            // Sequential resumption to prevent socket overload
            await processBroadcast(b._id, b.message, b.mediaUrl, b.mediaType).catch(e => logger.error('Resume Error:', e));
        }
    } catch (err) {
        logger.error('Self-healing check failed:', err);
    }
};

exports.disconnectWhatsApp = async (req, res) => {
    try {
        logger.info('🚨 Admin initiated WhatsApp session disconnect...');
        await whatsappService.closeWhatsApp();
        await whatsappService.clearSessionFromDb();
        
        // Wait 1.5s and re-initialize Baileys to produce a clean new QR code
        setTimeout(() => {
            whatsappService.initWhatsApp().catch(e => logger.error('Re-init WhatsApp Error:', e));
        }, 1500);

        return res.status(200).json({ success: true, message: 'WhatsApp disconnected. Generating a fresh QR code...' });
    } catch (err) {
        logger.error('Error disconnecting WhatsApp:', err);
        return res.status(500).json({ success: false, message: 'Server error: ' + err.message });
    }
};
