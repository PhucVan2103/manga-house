const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000; 

// --- CƠ CHẾ CACHE ĐƠN GIẢN ---
// Lưu kết quả cào trong 30 phút để không phải cào lại cùng 1 link nhiều lần
const scrapeCache = new Map();
const CACHE_TIMEOUT = 30 * 60 * 1000; // 30 phút

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

app.use(express.static(path.join(__dirname, 'public')));

/**
 * HÀM CỐT LÕI: Ngụy trang trình duyệt (Anti-AntiBot)
 * Bổ sung các Header bảo mật mà trình duyệt hiện đại thường dùng
 */
const getBrowserHeaders = (targetUrl = '') => {
    const headers = {
        // Giả lập Chrome mới nhất
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        // Các header bảo mật nâng cao giúp đánh lừa Cloudflare
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };
    
    if (targetUrl) {
        try {
            const urlObj = new URL(targetUrl);
            // Referer rất quan trọng để tránh 403 khi tải ảnh và trang
            headers['Referer'] = urlObj.origin + '/';
            headers['Origin'] = urlObj.origin;
        } catch (e) {}
    }
    
    return headers;
};

app.get('/api/scrape-chapter', async (req, res) => {
    const chapterUrl = req.query.url;
    if (!chapterUrl) return res.status(400).json({ error: 'Thiếu URL truyện' });

    // 1. KIỂM TRA CACHE TRƯỚC
    if (scrapeCache.has(chapterUrl)) {
        const cachedData = scrapeCache.get(chapterUrl);
        if (Date.now() - cachedData.timestamp < CACHE_TIMEOUT) {
            console.log(`[CACHE HIT] Trả kết quả tốc độ cao cho: ${chapterUrl}`);
            return res.json(cachedData.data);
        } else {
            // Xóa cache cũ
            scrapeCache.delete(chapterUrl);
        }
    }

    try {
        console.log(`\n[SCRAPER] Đang lấy dữ liệu từ: ${chapterUrl}`);
        
        const urlObj = new URL(chapterUrl);
        const origin = urlObj.origin;

        // Tăng timeout lên 30s để xử lý các nguồn chậm
        const response = await axios.get(chapterUrl, { 
            headers: getBrowserHeaders(chapterUrl),
            timeout: 30000 
        });
        
        const $ = cheerio.load(response.data);
        
        // Cào tên chương linh hoạt
        const chapterName = $('.txt-primary, .chapter-title, .name_chapter, h1').first().text().trim() || 'Chương không tên';

        let nextChapterUrl = $('.next a, .next-chap, a.next, .next-chapter').attr('href') || '';
        let prevChapterUrl = $('.prev a, .prev-chap, a.prev, .prev-chapter').attr('href') || '';

        const normalizeUrl = (url) => {
            if (!url || url === '#' || url.includes('javascript:')) return '';
            if (url.startsWith('//')) return `https:${url}`;
            if (url.startsWith('/')) return `${origin}${url}`;
            return url;
        };

        nextChapterUrl = normalizeUrl(nextChapterUrl);
        prevChapterUrl = normalizeUrl(prevChapterUrl);

        // --- TÌM NỘI DUNG TRUYỆN CHỮ ---
        const textSelectors = ['.chapter-c', '.chapter-content', '#chapter-c', '.js-truyen-noi-dung', '.content-story', '#chapter-content', '.reading-content'];
        let content = [];
        let textContainer = null;

        for (let selector of textSelectors) {
            if ($(selector).length > 0) {
                textContainer = $(selector);
                break;
            }
        }

        if (textContainer) {
            // Dọn dẹp rác (quảng cáo, script nằm trong nội dung)
            textContainer.find('script, style, iframe, ads, .ads, .hidden').remove();
            
            // Lấy các đoạn văn
            textContainer.find('p, div').each((i, el) => {
                const txt = $(el).text().trim();
                if (txt.length > 5) content.push(txt);
            });
            
            // Nếu không tìm thấy thẻ p, lấy text trực tiếp và ngắt dòng
            if (content.length === 0) {
                content = textContainer.text().split('\n').map(t => t.trim()).filter(t => t.length > 5);
            }
        }

        // --- TÌM NỘI DUNG ẢNH (TRUYỆN TRANH) ---
        const images = [];
        const imageSelectors = ['.page-chapter img', '.reading-detail img', '.div_image img', '.vung_doc img', '.story-see-content img'];
        
        $(imageSelectors.join(', ')).each((i, el) => {
            let imgUrl = $(el).attr('data-original') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('src');
            if (imgUrl && !imgUrl.includes('ads') && !imgUrl.includes('logo')) {
                // Truyền thêm origin vào API proxy để nó biết phải làm giả Referer là gì (Chống lỗi Hotlink 403 của CDN)
                images.push(`/api/proxy-image?url=${encodeURIComponent(normalizeUrl(imgUrl))}&origin=${encodeURIComponent(origin)}`);
            }
        });

        console.log(`[SCRAPER] Thành công! Tìm thấy: ${images.length} ảnh / ${content.length} đoạn text.`);
        
        const resultData = { 
            success: true, 
            chapter_name: chapterName, 
            content: content.length > 0 ? content : null,
            images: images.length > 0 ? images : null,
            next_chapter: nextChapterUrl,
            prev_chapter: prevChapterUrl
        };

        // 2. LƯU VÀO CACHE CHO CÁC LẦN TẢI SAU
        scrapeCache.set(chapterUrl, { timestamp: Date.now(), data: resultData });
        
        // Giới hạn kích thước cache để tránh tràn RAM (Tối đa 100 chương)
        if (scrapeCache.size > 100) scrapeCache.delete(scrapeCache.keys().next().value);

        res.json(resultData);

    } catch (error) {
        console.error('[SCRAPER] LỖI:', error.message);
        const status = error.response ? error.response.status : 500;
        res.status(status).json({ 
            success: false, 
            error: status === 403 ? 'Nguồn truyện chặn truy cập (403). Web này có Anti-bot quá mạnh.' : 'Lỗi kết nối hoặc Timeout.' 
        });
    }
});

/**
 * PROXY TẢI ẢNH: Xử lý vụ Hotlink (Ảnh bị chặn 403)
 */
app.get('/api/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    const originUrl = req.query.origin || imageUrl; // Sử dụng origin do frontend/scraper gửi lên
    
    if (!imageUrl) return res.status(400).send('URL không hợp lệ');

    try {
        const headers = getBrowserHeaders(originUrl);
        // Thiết lập đích danh các header ép CDN nhả ảnh
        headers['Accept'] = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
        headers['Sec-Fetch-Dest'] = 'image';

        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            headers: headers,
            timeout: 30000 // Tăng timeout cho proxy ảnh
        });

        const contentType = response.headers['content-type'];
        res.setHeader('Content-Type', contentType || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache ảnh ở trình duyệt 1 ngày
        
        response.data.pipe(res);
    } catch (error) {
        console.error(`[PROXY ERROR] Lỗi lấy ảnh: ${error.message} - URL: ${imageUrl.substring(0, 50)}...`);
        if (!res.headersSent) {
            // Trả về một ảnh rỗng hoặc thông báo lỗi để không làm treo thẻ <img>
            res.status(404).send('Lỗi ảnh');
        }
    }
});

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`SERVER ĐA NGUỒN ĐANG CHẠY TẠI PORT: ${PORT}`);
    console.log(`=========================================`);
});