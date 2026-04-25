const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const qs = require('querystring');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== AMMO DATA: Parse ItemData.htm ==========
let ammoData = {}; // { 'tên item viết thường': { name, max_quantity } }

function loadAmmoData() {
    try {
        const itemDataPath = path.join(__dirname, 'ItemData.htm');
        if (!fs.existsSync(itemDataPath)) {
            console.log("⚠️ Không tìm thấy ItemData.htm, bỏ qua ammo data.");
            return;
        }
        let raw = fs.readFileSync(itemDataPath, 'utf-8');
        // Decode HTML entities: &amp; -> &
        raw = raw.replace(/&amp;/g, '&');
        // Remove HTML tags
        raw = raw.replace(/<[^>]*>/g, '');

        // Parse all ammo entries: ammoN_name=xxx&ammoN_max_quantity=yyy
        const nameRegex = /ammo(\d+)_name=([^&]+)/g;
        const qtyRegex = /ammo(\d+)_max_quantity=(\d+)/g;

        const names = {};
        const qtys = {};
        let match;

        while ((match = nameRegex.exec(raw)) !== null) {
            names[match[1]] = decodeURIComponent(match[2]).trim();
        }
        while ((match = qtyRegex.exec(raw)) !== null) {
            qtys[match[1]] = parseInt(match[2]);
        }

        for (const id in names) {
            if (qtys[id]) {
                const ammoName = names[id];
                ammoData[ammoName.toLowerCase()] = {
                    name: ammoName,
                    max_quantity: qtys[id]
                };
            }
        }
        console.log(`✅ Đã load ${Object.keys(ammoData).length} loại ammo từ ItemData.htm`);
        console.log("   Danh sách:", Object.values(ammoData).map(a => `${a.name} (stack: ${a.max_quantity})`).join(", "));
    } catch (err) {
        console.error("❌ Lỗi đọc ItemData.htm:", err.message);
    }
}

// Kiểm tra item có phải ammo không (dựa trên tên tìm kiếm)
function getAmmoInfo(itemName) {
    if (!itemName) return null;
    const lower = itemName.toLowerCase().trim();
    // Tìm chính xác
    if (ammoData[lower]) return ammoData[lower];
    // Tìm gần đúng (item name chứa tên ammo hoặc ngược lại)
    for (const key in ammoData) {
        if (key.includes(lower) || lower.includes(key)) {
            return ammoData[key];
        }
    }
    return null;
}

loadAmmoData();

// Cấu hình bảo mật
const ADMIN_PASSWORD = "admin"; // Anh có thể đổi pass tại đây
let sessions = new Set();

// Database đơn giản bằng file
const dataDir = path.join(__dirname, 'data');
const configPath = path.join(dataDir, 'config.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

function createDefaultProfile(id) {
    return {
        id: id,
        name: `Profile ${id}`,
        items: [],
        selectedZones: [],
        interval: 60000,
        cookie: "",
        discordEnabled: false,
        webhook: "",
        roleId: ""
    }
}

function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) {
            const defaultConfig = {
                password: ADMIN_PASSWORD,
                profiles: [1, 2, 3, 4, 5].map(id => createDefaultProfile(id))
            };
            saveConfig(defaultConfig);
            return defaultConfig;
        }
        const data = JSON.parse(fs.readFileSync(configPath));
        // Migration for old config
        if (!data.profiles) {
            const migrated = {
                password: data.password || ADMIN_PASSWORD,
                profiles: [
                    {
                        id: 1,
                        name: "Profile 1",
                        items: data.items || [],
                        selectedZones: data.selectedZones || [],
                        interval: data.interval || 60000,
                        cookie: data.cookie || "",
                        discordEnabled: data.discordEnabled || false,
                        webhook: data.webhook || "",
                        roleId: data.roleId || ""
                    },
                    createDefaultProfile(2),
                    createDefaultProfile(3),
                    createDefaultProfile(4),
                    createDefaultProfile(5)
                ]
            };
            saveConfig(migrated);
            return migrated;
        }
        return data;
    } catch (err) {
        console.error("Lỗi đọc file cấu hình:", err);
        return {
            password: ADMIN_PASSWORD,
            profiles: [1, 2, 3, 4, 5].map(id => createDefaultProfile(id))
        };
    }
}

function saveConfig(config) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Logic Scraper Core
const TRADE_ZONES = [
    { name: "OP", tradezone: 21 },
    { name: "CV", tradezone: 22 },
    { name: "SEZ", tradezone: 9 },
    { name: "NZ", tradezone: 2 },
    { name: "NWZ", tradezone: 1 },
    { name: "NEZ", tradezone: 3 },
    { name: "SWZ", tradezone: 7 },
    { name: "SZ", tradezone: 8 },
    { name: "WZ", tradezone: 4 },
    { name: "EZ", tradezone: 6 },
    { name: "CZ", tradezone: 5 }
];

let latestPrices = {}; // { profileId: [] }
let isRunning = {};    // { profileId: boolean }
let intervalRefs = {}; // { profileId: intervalId }
let priceCache = {};   // { 'itemName_zone_profileId': price }
let notifiedPriceCache = {}; // { 'itemName_zone_profileId': lastNotifiedPrice }
let lastMessageId = {}; // { profileId: messageId }
let lastBargainKeys = {}; // { profileId: string }

async function sendDiscordEmbed(webhook, itemsFound, zones, roleId) {
    if (!webhook || itemsFound.length === 0) return null;

    const embeds = zones.map(zone => {
        const zoneItems = itemsFound.filter(it => it.zone === zone.name);
        if (zoneItems.length === 0) return null;

        return {
            title: `📍 Khu vực: ${zone.name}`,
            color: 0x00ff88,
            fields: zoneItems.map(it => {
                const ammoInfo = getAmmoInfo(it.name);
                let priceText = `💰 **Giá: $${it.price.toLocaleString()}**`;
                if (ammoInfo) {
                    // Dùng quantity thực tế từ listing (fallback max_quantity)
                    const qty = it.quantity || ammoInfo.max_quantity;
                    const perUnit = (it.price / qty).toFixed(2);
                    const normalized = Math.round((it.price / qty) * ammoInfo.max_quantity);
                    priceText += `\n📎 **$${perUnit}/viên** (${qty} viên)`;
                    priceText += `\n📊 Quy đổi ${ammoInfo.max_quantity} viên = **$${normalized.toLocaleString()}**`;
                }
                priceText += `\n🚨 Ngưỡng báo: $${it.alertPrice.toLocaleString()}${ammoInfo ? ` / ${ammoInfo.max_quantity} viên` : ''}`;
                return {
                    name: `📦 ${it.name}`,
                    value: priceText,
                    inline: true
                };
            }),
            timestamp: new Date().toISOString(),
            footer: { text: "DF Marketplace Tracker Web Pro" }
        };
    }).filter(e => e !== null);

    if (embeds.length === 0) return null;

    try {
        const payload = { embeds };
        if (roleId) payload.content = `🔔 Phát hiện đồ giá rẻ!`;

        const res = await axios.post(webhook + "?wait=true", payload);
        return res.data.id;
    } catch (err) {
        console.error("Lỗi gửi Discord:", err.message);
        return null;
    }
}

async function deleteDiscordMessage(webhook, messageId) {
    if (!messageId || !webhook) return;
    try {
        await axios.delete(`${webhook}/messages/${messageId}`);
    } catch { }
}

async function searchItem(item, zoneId, cookie) {
    try {
        let cookieString = cookie;
        // Tự động thêm tiền tố nếu người dùng chỉ dán mỗi mã
        if (cookie && !cookie.includes("=")) {
            cookieString = `PHPSESSID=${cookie}`;
        }

        const res = await axios.post(
            "https://fairview.deadfrontier.com/onlinezombiemmo/trade_search.php",
            qs.stringify({
                tradezone: zoneId,
                searchname: item.searchTerm,
                searchtype: "buyinglistitemname",
                search: "trades",
                memID: "",
                profession: "",
                category: ""
            }),
            {
                timeout: 8000,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Cookie": cookieString,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
            }
        );

        const raw = res.data;
        if (!raw || !raw.includes("tradelist_0_")) return null;

        // Parse từng listing theo index, lấy cả quantity
        const indices = new Set();
        const indexRegex = /tradelist_(\d+)_/g;
        let m;
        while ((m = indexRegex.exec(raw)) !== null) {
            indices.add(m[1]);
        }

        let results = [];
        for (const idx of indices) {
            const nameMatch = raw.match(new RegExp(`tradelist_${idx}_itemname=([^&]*)`));
            const priceMatch = raw.match(new RegExp(`tradelist_${idx}_price=(\\d+)`));
            const qtyMatch = raw.match(new RegExp(`tradelist_${idx}_quantity=(\\d+)`));

            if (nameMatch && priceMatch) {
                results.push({
                    name: decodeURIComponent(nameMatch[1]),
                    price: parseInt(priceMatch[1]),
                    quantity: qtyMatch ? parseInt(qtyMatch[1]) : 1
                });
            }
        }

        if (!results.length) return null;
        // Trả về toàn bộ kết quả, runCycle sẽ sort theo ammo/non-ammo
        return results;
    } catch (err) {
        return null;
    }
}

async function runCycle(profileId) {
    if (isRunning[profileId]) return;
    isRunning[profileId] = true;
    console.log(`--- Bắt đầu quét giá [Profile ${profileId}] ---`);

    try {
        const config = loadConfig();
        const profile = config.profiles.find(p => p.id === parseInt(profileId));

        if (!profile || !profile.cookie) {
            console.log(`⚠️ [Profile ${profileId}] Chưa có Cookie, dừng quét!`);
            isRunning[profileId] = false;
            return;
        }

        const items = profile.items || [];
        const selectedZones = (profile.selectedZones || []).map(i => TRADE_ZONES[i]);

        if (selectedZones.length === 0) selectedZones.push(TRADE_ZONES[0]);

        let updateTable = [];
        let currentBargains = [];
        let newHits = [];

        for (let zone of selectedZones) {
            console.log(`[Profile ${profileId}] Đang quét vùng: ${zone.name}...`);
            let zoneData = { zone: zone.name, items: [] };
            for (const item of items) {
                const cacheKey = `${item.searchTerm}_${zone.name}_${profileId}`;
                const allResults = await searchItem(item, zone.tradezone, profile.cookie);

                // Kiểm tra ammo dựa trên tên tìm kiếm trước
                const ammoInfo = getAmmoInfo(item.searchTerm);
                let result = null;

                if (allResults && allResults.length > 0) {
                    if (ammoInfo) {
                        // Ammo: sort theo giá/viên (rẻ nhất trên 1 viên)
                        allResults.sort((a, b) => (a.price / a.quantity) - (b.price / b.quantity));
                    } else {
                        // Non-ammo: sort theo giá tổng (rẻ nhất)
                        allResults.sort((a, b) => a.price - b.price);
                    }
                    result = allResults[0];
                    // Double-check ammo bằng tên kết quả nếu chưa match
                    if (!ammoInfo && result) {
                        const ammoCheck = getAmmoInfo(result.name);
                        if (ammoCheck) {
                            // Re-sort theo per-unit
                            allResults.sort((a, b) => (a.price / a.quantity) - (b.price / b.quantity));
                            result = allResults[0];
                        }
                    }
                }

                // Lấy lại ammoInfo chính xác từ kết quả
                const finalAmmoInfo = result ? (getAmmoInfo(result.name) || ammoInfo) : ammoInfo;

                let currentPrice = result ? result.price : (priceCache[cacheKey] || null);
                let hitResult = null;
                let pricePerUnit = null;
                let normalizedPrice = null; // Giá quy đổi về max stack
                let actualQuantity = result ? result.quantity : null;

                if (finalAmmoInfo && result) {
                    // Tính giá trên 1 viên = giá listing / số lượng thực tế trên chợ
                    pricePerUnit = result.price / result.quantity;
                    // Quy đổi về giá max stack = giá/viên * max_quantity
                    normalizedPrice = pricePerUnit * finalAmmoInfo.max_quantity;
                }

                if (result) {
                    priceCache[cacheKey] = result.price;

                    // Nếu là ammo: so sánh giá quy đổi về max stack vs ngưỡng báo
                    // Nếu không phải ammo: so sánh giá gốc vs ngưỡng báo
                    const priceToCompare = finalAmmoInfo ? normalizedPrice : result.price;
                    const isBelowThreshold = priceToCompare <= item.alert;

                    if (isBelowThreshold) {
                        hitResult = {
                            ...result,
                            zone: zone.name,
                            alertPrice: item.alert
                        };
                        currentBargains.push(hitResult);

                        const hasPriceChanged = notifiedPriceCache[cacheKey] !== result.price;
                        if (item.alertEnabled !== false && hasPriceChanged) {
                            newHits.push(hitResult);
                            notifiedPriceCache[cacheKey] = result.price;
                        }
                    } else {
                        // Reset notification cache if price goes above alert
                        delete notifiedPriceCache[cacheKey];
                    }

                    if (finalAmmoInfo) {
                        console.log(`✅ [${zone.name} - P${profileId}] ${item.searchTerm}: $${result.price.toLocaleString()} (${result.quantity} viên) → $${pricePerUnit.toFixed(2)}/viên → quy đổi ${finalAmmoInfo.max_quantity} viên = $${normalizedPrice.toLocaleString('en-US', {maximumFractionDigits: 0})}`);
                    } else {
                        console.log(`✅ [${zone.name} - P${profileId}] ${item.searchTerm}: $${result.price.toLocaleString()}`);
                    }
                } else {
                    console.log(`❌ [${zone.name} - P${profileId}] ${item.searchTerm}: N/A`);
                }

                const isNew = result && (notifiedPriceCache[cacheKey] !== result.price);

                zoneData.items.push({
                    name: result ? result.name : item.searchTerm,
                    price: currentPrice,
                    alert: hitResult !== null,
                    isNew: isNew,
                    // Thông tin ammo
                    isAmmo: !!finalAmmoInfo,
                    pricePerUnit: pricePerUnit,
                    normalizedPrice: normalizedPrice,
                    maxQuantity: finalAmmoInfo ? finalAmmoInfo.max_quantity : null,
                    actualQuantity: actualQuantity
                });
            }
            updateTable.push(zoneData);
        }
        latestPrices[profileId] = updateTable;

        // Xử lý thông báo Discord
        const currentBargainKeys = currentBargains.map(b => `${b.name}_${b.zone}_${b.price}`).sort().join('|');
        const contentChanged = currentBargainKeys !== (lastBargainKeys[profileId] || "");

        if (profile.discordEnabled) {
            if (newHits.length > 0 || contentChanged) {
                // Có thay đổi (đồ mới, đổi giá, hoặc đồ cũ biến mất)
                if (lastMessageId[profileId]) {
                    await deleteDiscordMessage(profile.webhook, lastMessageId[profileId]);
                }

                if (currentBargains.length > 0) {
                    const shouldTag = newHits.length > 0;
                    lastMessageId[profileId] = await sendDiscordEmbed(
                        profile.webhook,
                        currentBargains,
                        selectedZones,
                        shouldTag ? profile.roleId : "" // Chỉ truyền RoleId nếu cần Tag
                    );
                    lastBargainKeys[profileId] = currentBargainKeys;
                } else {
                    lastMessageId[profileId] = null;
                    lastBargainKeys[profileId] = "";
                }
            }
        }

        console.log(`--- Quét xong [Profile ${profileId}] ---`);
    } catch (err) {
        console.error(`🔥 Lỗi vòng lặp [Profile ${profileId}]:`, err.message);
    } finally {
        isRunning[profileId] = false;
    }
}

// API Endpoints
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const config = loadConfig();
    if (password === (config.password || ADMIN_PASSWORD)) {
        const token = Math.random().toString(36).substring(7);
        sessions.add(token);
        res.json({ success: true, token });
    } else {
        res.json({ success: false, message: "Sai mật khẩu" });
    }
});

const auth = (req, res, next) => {
    const token = req.headers['authorization'];
    if (sessions.has(token)) next();
    else res.status(401).json({ message: "Chưa đăng nhập" });
};

// GET full config
app.get('/api/config', auth, (req, res) => {
    res.json(loadConfig());
});

// POST full config
app.post('/api/config', auth, (req, res) => {
    saveConfig(req.body);
    res.json({ success: true });
});

// Export config file
app.get('/api/config/export', auth, (req, res) => {
    res.download(configPath, 'config.json');
});

// Add new profile
app.post('/api/profile/add', auth, (req, res) => {
    const config = loadConfig();
    const nextId = config.profiles.length > 0 ? Math.max(...config.profiles.map(p => p.id)) + 1 : 1;
    const newProfile = createDefaultProfile(nextId);
    config.profiles.push(newProfile);
    saveConfig(config);
    res.json({ success: true, profile: newProfile });
});

// Delete profile
app.post('/api/profile/delete', auth, (req, res) => {
    const { profileId } = req.body;
    const config = loadConfig();
    const index = config.profiles.findIndex(p => p.id === parseInt(profileId));

    if (index === -1) return res.status(400).json({ error: "Profile not found" });
    if (config.profiles.length <= 1) return res.status(400).json({ error: "Cannot delete the last profile" });

    // Stop scraper if running
    if (intervalRefs[profileId]) {
        clearInterval(intervalRefs[profileId]);
        delete intervalRefs[profileId];
    }

    config.profiles.splice(index, 1);
    saveConfig(config);
    res.json({ success: true });
});

app.get('/api/status', auth, (req, res) => {
    const pId = req.query.profileId || 1;
    res.json({
        isRunning: !!intervalRefs[pId],
        isScanning: !!isRunning[pId],
        lastUpdate: new Date().toLocaleTimeString()
    });
});

app.get('/api/prices', auth, (req, res) => {
    const pId = req.query.profileId || 1;
    res.json(latestPrices[pId] || []);
});

// API: Lấy thông tin ammo data
app.get('/api/ammo-data', auth, (req, res) => {
    res.json(ammoData);
});

app.post('/api/start', auth, async (req, res) => {
    const pId = req.body.profileId || 1;
    if (intervalRefs[pId]) return res.json({ success: true });

    const config = loadConfig();
    const profile = config.profiles.find(p => p.id === parseInt(pId));

    if (!profile) return res.status(400).json({ error: "Profile not found" });

    runCycle(pId);

    intervalRefs[pId] = setInterval(() => runCycle(pId), profile.interval || 60000);
    res.json({ success: true });
});

app.post('/api/refresh', auth, async (req, res) => {
    const pId = req.body.profileId || 1;
    await runCycle(pId);
    res.json({ success: true });
});

app.post('/api/stop', auth, (req, res) => {
    const pId = req.body.profileId || 1;
    if (intervalRefs[pId]) {
        clearInterval(intervalRefs[pId]);
        intervalRefs[pId] = null;
    }
    res.json({ success: true });
});
app.listen(PORT, () => {
    console.log(`Web Scraper Pro running at http://localhost:${PORT}`);

    // Tự động khởi chạy tất cả Profile có Cookie khi Server boot
    const config = loadConfig();
    config.profiles.forEach(profile => {
        if (profile.cookie) {
            console.log(`🚀 Tự động chạy Profile ${profile.id}...`);
            runCycle(profile.id);
            intervalRefs[profile.id] = setInterval(() => runCycle(profile.id), profile.interval || 60000);
        }
    });
});
