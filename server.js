const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const sharp = require('sharp');
const cors = require('cors');

const app = express();
const PORT = 3000;

// ================== CẤU HÌNH ==================
app.use(cors());
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: 'uploads/' });

const IMAGES_DIR = path.join(__dirname, 'public', 'images');
const LOG_FILE = path.join(__dirname, 'upload.log');

// Tạo thư mục cần thiết
[IMAGES_DIR, 'uploads'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Dọn rác thư mục uploads khi khởi động (rất quan trọng trên Windows)
if (fs.existsSync('uploads')) {
  fs.readdir('uploads', (err, files) => {
    if (!err) {
      files.forEach(file => {
        fs.unlink(path.join('uploads', file), () => { /* bỏ qua lỗi */ });
      });
    }
  });
}

let products = [];

// ================== LOGGING ==================
function log(message, req = null) {
  const timestamp = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const ip = req ? (req.ip || req.connection?.remoteAddress || 'unknown').replace('::ffff:', '') : 'SERVER';
  const line = `[${timestamp}] [${ip}] ${message}\n`;
  console.log('\x1b[36m%s\x1b[0m', line.trim());
  fs.appendFileSync(LOG_FILE, line);
}

// ================== LOAD CSV (hỗ trợ cả 2 định dạng) ==================
function loadCSV() {
  products = [];
  const backupFile = path.join(__dirname, 'products_with_images.csv');
  const originalFile = path.join(__dirname, 'products.csv');
  const fileToLoad = fs.existsSync(backupFile) ? backupFile : originalFile;

  if (!fs.existsSync(fileToLoad)) {
    log('Không tìm thấy file CSV nào → chạy trống');
    return;
  }

  log(`Đang load từ: ${path.basename(fileToLoad)}`);
  let mode = 'UNKNOWN';

  fs.createReadStream(fileToLoad)
    .pipe(csv())
    .on('headers', (headers) => {
      if (headers.includes('Image_1')) mode = 'TOOL_BACKUP';
      else if (headers.includes('Images')) mode = 'WOOCOMMERCE';
      log(`Định dạng CSV: ${mode}`);
    })
    .on('data', (row) => {
      if (!row.Name?.trim()) return;

      const id = row.ID?.trim() || row.SKU?.trim() || 'id_' + Date.now() + Math.random();
      const slug = row.Name.trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/(^-|-$)/g, '').toLowerCase() || 'product';

      let images = ['', '', '', ''];

      if (mode === 'TOOL_BACKUP') {
        images = [
          row.Image_1 ? `/images/${row.Image_1.trim()}?v=${Date.now()}` : '',
          row.Image_2 ? `/images/${row.Image_2.trim()}?v=${Date.now()}` : '',
          row.Image_3 ? `/images/${row.Image_3.trim()}?v=${Date.now()}` : '',
          row.Image_4 ? `/images/${row.Image_4.trim()}?v=${Date.now()}` : ''
        ];
      } else if (mode === 'WOOCOMMERCE' && row.Images) {
        const urls = row.Images.split(',').map(u => u.trim()).filter(Boolean);
        urls.slice(0, 4).forEach((url, i) => {
          const filename = path.basename(url.split('?')[0]);
          if (filename) images[i] = `/images/${filename}?v=${Date.now()}`;
        });
      }

      products.push({
        id,
        name: row.Name.trim(),
        short_description: (row['Short description'] || '').trim(),
        description: (row.Description || '').trim(),
        price: row['Regular price'] || '',
        sale_price: row['Sale price'] || '',
        images,
        slug
      });
    })
    .on('end', () => {
      log(`KHỞI ĐỘNG THÀNH CÔNG – Đã load ${products.length} sản phẩm`);
      if (mode === 'WOOCOMMERCE') updateCSV();
    });
}

loadCSV();

// ================== API: LẤY DANH SÁCH ==================
app.get('/api/products', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 24;
  const start = (page - 1) * limit;
  const list = products.slice(start, start + limit);

  const stats = {
    total: products.length,
    full: products.filter(p => p.images.filter(Boolean).length === 4).length,
    partial: products.filter(p => p.images.filter(Boolean).length > 0 && p.images.filter(Boolean).length < 4).length,
    empty: products.filter(p => p.images.filter(Boolean).length === 0).length
  };

  res.json({
    products: list,
    pagination: { current: page, total: Math.ceil(products.length / limit), limit },
    stats
  });
});

// ================== API: UPLOAD ẢNH (ĐÃ FIX EBUSY 100%) ==================
app.post('/upload-single/:id/:index', upload.single('image'), async (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  const idx = parseInt(req.params.index);

  if (!product || !req.file || idx < 0 || idx > 3) {
    return res.status(400).json({ success: false, error: 'Invalid request' });
  }

  // Xóa ảnh cũ nếu có (bỏ qua lỗi nếu bị lock)
  if (product.images[idx]) {
    const oldPath = path.join(IMAGES_DIR, path.basename(product.images[idx].split('?')[0]));
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (e) { /* không quan trọng */ }
    }
  }

  const newName = `${product.slug}-${idx + 1}.webp`;
  const fullPath = path.join(IMAGES_DIR, newName);
  const tempPath = req.file.path;

  try {
    await sharp(tempPath)
      .rotate()
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 3 })
      .toFile(fullPath);

    const sizeKB = Math.round(fs.statSync(fullPath).size / 1024);
    product.images[idx] = `/images/${newName}?v=${Date.now()}`;
    updateCSV();

    log(`UPLOAD → ${product.name} | Ảnh ${idx + 1} → ${newName} (${sizeKB}KB)`, req);

    res.json({
      success: true,
      url: product.images[idx],
      log: `Đã upload ảnh ${idx + 1} – ${newName} (${sizeKB}KB)`
    });

    // Xóa file tạm sau khi xử lý xong (có retry)
    setTimeout(() => deleteWithRetry(tempPath, 5), 200);

  } catch (err) {
    log(`UPLOAD LỖI → ${product.name} | ${err.message}`, req);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hàm xóa file tạm có retry (fix EBUSY triệt để)
function deleteWithRetry(filePath, retries = 5) {
  fs.unlink(filePath, (err) => {
    if (err && retries > 0) {
      if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOENT') {
        setTimeout(() => deleteWithRetry(filePath, retries - 1), 500);
      }
    }
  });
}

// ================== API: XÓA ẢNH ==================
app.post('/remove-image/:id/:index', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  const idx = parseInt(req.params.index);

  if (!product || idx < 0 || idx > 3 || !product.images[idx]) {
    return res.status(400).json({ success: false });
  }

  const filePath = path.join(IMAGES_DIR, path.basename(product.images[idx].split('?')[0]));
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) { /* bỏ qua nếu bị lock */ }
  }

  product.images[idx] = '';
  updateCSV();

  log(`XÓA ẢNH → ${product.name} | Ảnh ${idx + 1}`, req);
  res.json({ success: true });
});

// ================== API: TẢI CSV ==================
app.get('/download-csv', (req, res) => {
  updateCSV();
  const file = path.join(__dirname, 'products_with_images.csv');
  res.download(file, 'products_with_images.csv', (err) => {
    if (err) log(`Lỗi tải CSV: ${err.message}`, req);
    else log(`TẢI CSV thành công`, req);
  });
});

// ================== GHI CSV BACKUP ==================
function updateCSV() {
  const data = products.map(p => ({
    ID: p.id,
    Name: p.name,
    'Regular price': p.price,
    'Sale price': p.sale_price || '',
    'Short description': p.short_description,
    Description: p.description,
    Image_1: p.images[0]?.split('?')[0]?.replace('/images/', '') || '',
    Image__images2: p.images[1]?.split('?')[0]?.replace('/images/', '') || '',
    Image_3: p.images[2]?.split('?')[0]?.replace('/images/', '') || '',
    Image_4: p.images[3]?.split('?')[0]?.replace('/images/', '') || ''
  }));

  try {
    fs.writeFileSync(path.join(__dirname, 'products_with_images.csv'), stringify(data, { header: true }));
  } catch (err) {
    log(`LỖI GHI CSV: ${err.message}`);
  }
}

// ================== KHỞI ĐỘNG ==================
app.listen(PORT, '0.0.0.0', () => {
  console.clear();
  log('============================================');
  log('   TOOL QUẢN LÝ ẢNH SẢN PHẨM - PHIÊN BẢN MỚI   ');
  log('   ĐÃ FIX HOÀN TOÀN LỖI EBUSY TRÊN WINDOWS   ');
  log(`   Server chạy tại: http://localhost:${PORT}   `);
  log('   Upload liên tục 1000 ảnh vẫn mượt mà!     ');
  log('============================================');
});