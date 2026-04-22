const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000; 

const scrapeCache = new Map();
const CACHE_TIMEOUT = 30 * 60 * 1000; 
const baseDir = __dirname.endsWith('dist') ? path.join(__dirname, '..') : __dirname;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.static(path.join(baseDir, 'public')));

app.get('/', (req, res) => { res.sendFile(path.join(baseDir, 'public', 'index.html')); });

// ==========================================
// GOOGLE DRIVE API (Pure Node.js)
// ==========================================
let driveCredentials = null, accessToken = null, tokenExpiry = 0;
try {
    const credPath = path.join(baseDir, 'credentials.json');
    if (fs.existsSync(credPath)) driveCredentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
} catch (err) {}

async function getAccessToken() {
    if (!driveCredentials) throw new Error("Chưa cấu hình Google Drive");
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    const header = { alg: 'RS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000) - 60; 
    const claim = { iss: driveCredentials.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
    
    const encodeBase64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signatureInput = `${encodeBase64Url(header)}.${encodeBase64Url(claim)}`;
    const sign = crypto.createSign('RSA-SHA256'); sign.update(signatureInput);
    const signature = sign.sign(driveCredentials.private_key, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = `${signatureInput}.${signature}`;

    const response = await axios.post('https://oauth2.googleapis.com/token', 
        `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`, 
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    accessToken = response.data.access_token; 
    tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
    return accessToken;
}

app.get('/api/read-drive-chapter', async (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) return res.status(400).json({ error: 'Thiếu URL Google Drive' });
    if (scrapeCache.has(chapterUrl)) { const cd = scrapeCache.get(chapterUrl); if (Date.now() - cd.timestamp < CACHE_TIMEOUT) return res.json(cd.data); }

    try {
        const currentFileId = chapterUrl.match(/[-\w]{25,}/)?.[0];
        if (!currentFileId) throw new Error('Không tìm thấy File ID');
        const token = await getAccessToken(); 
        const h = { Authorization: `Bearer ${token}` };
        
        const metaRes = await axios.get(`https://www.googleapis.com/drive/v3/files/${currentFileId}?fields=name,parents`, { headers: h });
        const contentRes = await axios.get(`https://www.googleapis.com/drive/v3/files/${currentFileId}?alt=media`, { headers: h, responseType: 'text' });
        const fileMeta = metaRes.data;
        const contentArray = typeof contentRes.data === 'string' ? contentRes.data.split('\n').map(p => p.trim()).filter(p => p.length > 0) : [];
        
        let nextChapterUrl = '', prevChapterUrl = '';
        if (fileMeta.parents && fileMeta.parents[0]) {
            const siblingRes = await axios.get(`https://www.googleapis.com/drive/v3/files?q='${fileMeta.parents[0]}'+in+parents+and+trashed=false+and+mimeType!='application/vnd.google-apps.folder'&orderBy=name&fields=files(id,name)`, { headers: h });
            const files = siblingRes.data.files || []; 
            const idx = files.findIndex(f => f.id === currentFileId);
            if (idx > 0) prevChapterUrl = `https://drive.google.com/file/d/${files[idx - 1].id}/view`;
            if (idx < files.length - 1 && idx !== -1) nextChapterUrl = `https://drive.google.com/file/d/${files[idx + 1].id}/view`;
        }
        const resultData = { success: true, chapter_name: fileMeta.name.replace(/\.[^/.]+$/, ""), content: contentArray, images: null, next_chapter: nextChapterUrl, prev_chapter: prevChapterUrl };
        scrapeCache.set(chapterUrl, { timestamp: Date.now(), data: resultData }); 
        res.json(resultData);
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ==========================================
// CÀO HTML (Tương thích hoàn hảo với a-Shell)
// ==========================================
app.get('/api/scrape-chapter', async (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) return res.status(400).json({ error: 'Thiếu URL truyện' });

    if (scrapeCache.has(chapterUrl)) { 
        const cd = scrapeCache.get(chapterUrl); 
        if (Date.now() - cd.timestamp < CACHE_TIMEOUT) return res.json(cd.data); 
    }

    try {
        console.log(`[SCRAPER] Đang cào HTML bằng Axios (a-Shell): ${chapterUrl}`);
        const response = await axios.get(chapterUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000 // Tối đa 10s cho mỗi request
        });
        
        const htmlData = response.data;
        const origin = new URL(chapterUrl).origin; 
        const $ = cheerio.load(htmlData);
        
        const chapterName = $('.txt-primary, .chapter-title, .name_chapter, h1').first().text().trim() || 'Chương không tên';
        const normalizeUrl = (u) => { if (!u || u === '#' || u.includes('javascript:')) return ''; if (u.startsWith('//')) return `https:${u}`; if (u.startsWith('/')) return `${origin}${u}`; return u; };

        let nextChapterUrl = normalizeUrl($('.next a, .next-chap, a.next, .next-chapter').attr('href'));
        let prevChapterUrl = normalizeUrl($('.prev a, .prev-chap, a.prev, .prev-chapter').attr('href'));

        let content = [], textContainer = null;
        for (let selector of ['.chapter-c', '.chapter-content', '#chapter-c', '.js-truyen-noi-dung', '.content-story']) { if ($(selector).length > 0) { textContainer = $(selector); break; } }
        if (textContainer) {
            textContainer.find('script, style, iframe, ads, .ads, .hidden').remove();
            textContainer.find('p, div').each((i, el) => { const txt = $(el).text().trim(); if (txt.length > 5) content.push(txt); });
            if (content.length === 0) content = textContainer.text().split('\n').map(t => t.trim()).filter(t => t.length > 5);
        }

        const images = [];
        $('.page-chapter img, .reading-detail img, .div_image img, .vung_doc img').each((i, el) => {
            let imgUrl = $(el).attr('data-original') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src');
            if (imgUrl && !imgUrl.includes('ads') && !imgUrl.includes('logo')) {
                let cleanUrl = normalizeUrl(imgUrl.trim());
                if (cleanUrl.startsWith('http')) images.push(cleanUrl);
            }
        });

        const resultData = { success: true, chapter_name: chapterName, content: content.length > 0 ? content : null, images: images.length > 0 ? images : null, next_chapter: nextChapterUrl, prev_chapter: prevChapterUrl };
        scrapeCache.set(chapterUrl, { timestamp: Date.now(), data: resultData }); 
        res.json(resultData);

    } catch (error) {
        console.error(`[SCRAPER] Node.js thất bại (Có thể do Cloudflare): ${error.message}`);
        // Cố tình trả về lỗi 500 để Frontend tự động "Bật khiên" và đi cào bằng Proxy Công cộng.
        res.status(500).json({ success: false, error: 'Web chặn tường lửa. Frontend sẽ tự động tiếp quản!' }); 
    }
});

app.listen(PORT, '0.0.0.0', () => { 
    console.log(`SERVER ĐANG CHẠY TẠI PORT: ${PORT}`); 
    console.log(`Kiến trúc Native a-Shell: Đã gỡ bỏ tiến trình ảo, tối ưu RAM tuyệt đối.`);
});