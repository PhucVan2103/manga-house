const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000; 

const scrapeCache = new Map();
const CACHE_TIMEOUT = 30 * 60 * 1000; 

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

app.use(express.static(path.join(__dirname, 'public')));

let driveAPI = null;
try {
    const auth = new google.auth.GoogleAuth({
        keyFile: path.join(__dirname, 'credentials.json'),
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    driveAPI = google.drive({ version: 'v3', auth });
    console.log("[SERVER] Đã kết nối Google Drive API thành công!");
} catch (err) {
    console.log("[SERVER] Lỗi: Chưa tìm thấy credentials.json.");
}

const extractDriveId = (url) => {
    const match = url.match(/[-\w]{25,}/);
    return match ? match[0] : null;
};

// ==========================================
// API: ĐỌC TRUYỆN TỪ GOOGLE DRIVE (ĐÃ SỬA LỖI)
// ==========================================
app.get('/api/read-drive-chapter', async (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) return res.status(400).json({ error: 'Thiếu URL Google Drive' });

    if (!driveAPI) return res.status(500).json({ success: false, error: "Server chưa cấu hình Google Drive API" });

    if (scrapeCache.has(chapterUrl)) {
        const cachedData = scrapeCache.get(chapterUrl);
        if (Date.now() - cachedData.timestamp < CACHE_TIMEOUT) return res.json(cachedData.data);
    }

    try {
        const inputId = extractDriveId(chapterUrl);
        if (!inputId) return res.status(400).json({ error: 'Không tìm thấy ID trong URL' });

        // 1. Kiểm tra xem URL nhập vào là Thư mục hay File
        const fileMeta = await driveAPI.files.get({
            fileId: inputId,
            fields: 'name, mimeType, parents'
        });

        let targetFileId = inputId;
        let targetMimeType = fileMeta.data.mimeType;
        let chapterName = fileMeta.data.name;
        let parentId = fileMeta.data.parents ? fileMeta.data.parents[0] : null;

        // Nếu là Thư mục (Folder) -> Tự động tìm file đầu tiên bên trong
        if (targetMimeType === 'application/vnd.google-apps.folder') {
            parentId = inputId;
            const filesRes = await driveAPI.files.list({
                q: `'${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
                orderBy: 'name',
                pageSize: 1,
                fields: 'files(id, name, mimeType)'
            });
            
            if (!filesRes.data.files || filesRes.data.files.length === 0) {
                return res.status(404).json({ success: false, error: 'Thư mục này trống, không có file truyện nào.' });
            }
            
            targetFileId = filesRes.data.files[0].id;
            chapterName = filesRes.data.files[0].name;
            targetMimeType = filesRes.data.files[0].mimeType;
        }

        chapterName = chapterName.replace(/\.[^/.]+$/, ""); // Bỏ đuôi .txt

        // 2. Lấy nội dung chữ (Hỗ trợ cả .txt và Google Docs)
        let rawText = '';
        if (targetMimeType === 'application/vnd.google-apps.document') {
            // Google Docs cần dùng export
            const exportRes = await driveAPI.files.export({
                fileId: targetFileId,
                mimeType: 'text/plain'
            });
            rawText = exportRes.data;
        } else {
            // File .txt thuần
            const getRes = await driveAPI.files.get({
                fileId: targetFileId,
                alt: 'media'
            }, { responseType: 'text' });
            rawText = getRes.data;
        }

        const contentArray = rawText.split('\n').map(p => p.trim()).filter(p => p.length > 0);

        // 3. Tìm chương trước / sau trong cùng thư mục
        let nextChapterUrl = '';
        let prevChapterUrl = '';

        if (parentId) {
            const siblingFiles = await driveAPI.files.list({
                q: `'${parentId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
                orderBy: 'name', // Xếp theo tên (Chương 1, Chương 2...)
                fields: 'files(id, name)'
            });

            const files = siblingFiles.data.files;
            const currentIndex = files.findIndex(f => f.id === targetFileId);

            if (currentIndex > 0) prevChapterUrl = `https://drive.google.com/file/d/${files[currentIndex - 1].id}/view`;
            if (currentIndex !== -1 && currentIndex < files.length - 1) nextChapterUrl = `https://drive.google.com/file/d/${files[currentIndex + 1].id}/view`;
        }

        const resultData = {
            success: true,
            chapter_name: chapterName,
            content: contentArray,
            images: null,
            next_chapter: nextChapterUrl,
            prev_chapter: prevChapterUrl,
            current_chapter_url: `https://drive.google.com/file/d/${targetFileId}/view` // Trả về link file gốc để Frontend lưu tiến trình
        };

        scrapeCache.set(chapterUrl, { timestamp: Date.now(), data: resultData });
        res.json(resultData);

    } catch (error) {
        console.error('[DRIVE ERROR]', error.message);
        res.status(500).json({ success: false, error: 'Lỗi đọc file. Hãy chắc chắn bạn đã share file/thư mục cho email của bot.' });
    }
});

// ==========================================
// API: ĐỌC TỪ WEB TRUYỆN TRANH
// ==========================================
// ... (Phần code cào web giữ nguyên như bản cũ của bạn) ...
const getBrowserHeaders = (targetUrl = '') => {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'max-age=0'
    };
    if (targetUrl) {
        try { const urlObj = new URL(targetUrl); headers['Referer'] = urlObj.origin + '/'; headers['Origin'] = urlObj.origin; } catch (e) {}
    }
    return headers;
};

app.get('/api/scrape-chapter', async (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) return res.status(400).json({ error: 'Thiếu URL truyện' });
    try {
        const urlObj = new URL(chapterUrl);
        const origin = urlObj.origin;
        const response = await axios.get(chapterUrl, { headers: getBrowserHeaders(chapterUrl), timeout: 30000 });
        const $ = cheerio.load(response.data);
        const chapterName = $('.txt-primary, .chapter-title, .name_chapter, h1').first().text().trim() || 'Chương không tên';
        let nextChapterUrl = $('.next a, .next-chap, a.next, .next-chapter').attr('href') || '';
        let prevChapterUrl = $('.prev a, .prev-chap, a.prev, .prev-chapter').attr('href') || '';
        const normalizeUrl = (url) => {
            if (!url || url === '#' || url.includes('javascript:')) return '';
            if (url.startsWith('//')) return `https:${url}`;
            if (url.startsWith('/')) return `${origin}${url}`;
            return url;
        };
        nextChapterUrl = normalizeUrl(nextChapterUrl); prevChapterUrl = normalizeUrl(prevChapterUrl);
        const textSelectors = ['.chapter-c', '.chapter-content', '#chapter-c', '.js-truyen-noi-dung', '.content-story', '#chapter-content', '.reading-content'];
        let content = []; let textContainer = null;
        for (let selector of textSelectors) { if ($(selector).length > 0) { textContainer = $(selector); break; } }
        if (textContainer) {
            textContainer.find('script, style, iframe, ads, .ads, .hidden').remove();
            textContainer.find('p, div').each((i, el) => {
                const txt = $(el).text().trim(); if (txt.length > 5) content.push(txt);
            });
            if (content.length === 0) content = textContainer.text().split('\n').map(t => t.trim()).filter(t => t.length > 5);
        }
        const images = [];
        const imageSelectors = ['.page-chapter img', '.reading-detail img', '.div_image img', '.vung_doc img', '.story-see-content img'];
        $(imageSelectors.join(', ')).each((i, el) => {
            let imgUrl = $(el).attr('data-original') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src');
            if (imgUrl && !imgUrl.includes('ads') && !imgUrl.includes('logo')) {
                images.push(`/api/proxy-image?url=${encodeURIComponent(normalizeUrl(imgUrl))}&origin=${encodeURIComponent(origin)}`);
            }
        });
        res.json({ success: true, chapter_name: chapterName, content: content.length > 0 ? content : null, images: images.length > 0 ? images : null, next_chapter: nextChapterUrl, prev_chapter: prevChapterUrl });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Lỗi kết nối.' });
    }
});

app.get('/api/proxy-image', async (req, res) => {
    try {
        const response = await axios({ url: req.query.url, method: 'GET', responseType: 'stream', headers: getBrowserHeaders(req.query.origin || req.query.url), timeout: 30000 });
        res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
        response.data.pipe(res);
    } catch (error) { res.status(404).send('Lỗi ảnh'); }
});

app.listen(PORT, () => { console.log(`SERVER ĐANG CHẠY TẠI PORT: ${PORT}`); });