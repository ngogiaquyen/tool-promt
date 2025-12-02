// public/js/app.js
let page = 1;
let limit = 24;

function showLog(msg) {
  const box = document.getElementById('log-box');
  const line = document.createElement('div');
  line.textContent = msg;
  line.style.margin = '4px 0';
  box.appendChild(line);
  box.classList.add('show');
  setTimeout(() => {
    box.classList.remove('show');
    setTimeout(() => box.innerHTML = '', 1000);
  }, 4000);
}

async function compressImage(file) {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.src = url;
  await new Promise(r => img.onload = r);

  const MAX = 1200;
  let w = img.width, h = img.height;
  if (w > MAX || h > MAX) {
    if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
    else { w = Math.round(w * MAX / h); h = MAX; }
  }

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(url);

  return new Promise(resolve => {
    canvas.toBlob(blob => {
      resolve(new File([blob], file.name.replace(/\.[^/.]+$/, ".webp"), { type: 'image/webp' }));
    }, 'image/webp', 0.82);
  });
}

async function load(p = 1) {
  page = p;
  const res = await fetch(`/api/products?page=${page}&limit=${limit}`);
  const d = await res.json();

  document.getElementById('total').textContent = d.stats.total;
  document.getElementById('full').textContent = d.stats.full;
  document.getElementById('partial').textContent = d.stats.partial;
  document.getElementById('empty').textContent = d.stats.empty;

  document.getElementById('grid').innerHTML = d.products.map(p => {
    const c = p.images.filter(Boolean).length;
    return `<div class="card">
      <div class="images-grid">
        ${[0,1,2,3].map(i => `
          <div class="img-box" id="box-${p.id}-${i}"
               ondrop="drop(event,'${p.id}',${i})"
               ondragover="e=>e.preventDefault()||e.currentTarget.classList.add('dragover')"
               ondragleave="e=>e.currentTarget.classList.remove('dragover')"
               onclick="this.querySelector('input').click()">
            ${p.images[i] ? `
              <img src="${p.images[i]}">
              <button class="remove-btn" onclick="remove('${p.id}',${i},event)">X</button>
              <button class="download-btn" onclick="downloadImage('${p.images[i]}', '${p.slug}-${i+1}.webp', event)" title="Tải ảnh xuống">Down Arrow</button>
            ` : `<div class="placeholder">Kéo thả<br><strong>Ảnh ${i+1}</strong></div>`}
            <div class="img-label">Ảnh ${i+1}</div>
            
            <!-- LOADING OVERLAY SIÊU ĐẸP -->
            <div class="loading-overlay" id="load-${p.id}-${i}">
              <div class="spinner"></div>
              <div class="loading-text">Đang tải lên...</div>
            </div>
            
            <input type="file" accept="image/*" style="display:none" onchange="upload(this.files[0],'${p.id}',${i})">
          </div>
        `).join('')}
      </div>
      <div class="info">
        <div class="name">${p.name}</div>
        <div class="status ${c===4?'full':c===0?'empty':'lack'}">${c===4?'Đủ 4':c===0?'Chưa có':c+'/4'}</div>
        <button class="btn-copy" onclick="copyPrompt('${p.id}')">Copy tên</button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('pagination').innerHTML = `
    <button onclick="load(${d.pagination.current-1})" ${d.pagination.current===1?'disabled':''}>Trước</button>
    <span>Trang ${d.pagination.current} / ${d.pagination.total}</span>
    <button onclick="load(${d.pagination.current+1})" ${d.pagination.current===d.pagination.total?'disabled':''}>Sau</button>
    <select onchange="limit=this.value;load(1)">
      <option value="24" ${limit==24?'selected':''}>24</option>
      <option value="50" ${limit==50?'selected':''}>50</option>
      <option value="100" ${limit==100?'selected':''}>100</option>
    </select>`;
}

function downloadImage(url, filename, e) {
  e.stopPropagation();
  fetch(url).then(r => r.blob()).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    showLog(`Đã tải: ${filename}`);
  });
}

async function upload(file, id, i) {
  if (!file) return;

  // HIỆN OVERLAY FULL MÀN HÌNH
  document.getElementById('global-loading').classList.add('active');
  document.body.style.overflow = 'hidden'; // khóa scroll
    console.log("đang tải lên...");
  try {
    const compressed = await compressImage(file);
    const f = new FormData();
    f.append('image', compressed);

    const res = await fetch(`/upload-single/${id}/${i}`, { method: 'POST', body: f });
    const json = await res.json();

    if (json.success) {
      const box = document.getElementById(`box-${id}-${i}`);
      box.innerHTML = `
        <img src="${json.url}">
        <button class="remove-btn" onclick="remove('${id}',${i},event)">X</button>
        <button class="download-btn" onclick="downloadImage('${json.url}', '${json.url.split('/').pop().split('?')[0]}', event)" title="Tải ảnh xuống">Down Arrow</button>
        <div class="img-label">Ảnh ${i+1}</div>
        <div class="loading-overlay" id="load-${id}-${i}"></div>
        <input type="file" accept="image/*" style="display:none" onchange="upload(this.files[0],'${id}',${i})">
      `;
      updateStatusCard(id);
      updateGlobalStats();
      showLog(json.log);
    } else {
      showLog('Lỗi upload ảnh ' + (i+1));
    }
  } catch (err) {
    showLog('Lỗi xử lý ảnh');
  } finally {
    // ẨN OVERLAY FULL MÀN HÌNH
    document.getElementById('global-loading').classList.remove('active');
    document.body.style.overflow = 'auto';
  }
}

function drop(e, id, i) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  upload(e.dataTransfer.files[0], id, i);
}

async function remove(id, i, e) {
  e.stopPropagation();
  if (!confirm('Xóa ảnh này?')) return;
  await fetch(`/remove-image/${id}/${i}`, { method: 'POST' });
  const box = document.getElementById(`box-${id}-${i}`);
  box.innerHTML = `
    <div class="placeholder">Kéo thả<br><strong>Ảnh ${i+1}</strong></div>
    <div class="img-label">Ảnh ${i+1}</div>
    <div class="loading-overlay" id="load-${id}-${i}">
      <div class="spinner"></div>
      <div class="loading-text">Đang tải lên...</div>
    </div>
    <input type="file" accept="image/*" style="display:none" onchange="upload(this.files[0],'${id}',${i})">
  `;
  updateStatusCard(id);
  updateGlobalStats();
  showLog(`Đã xóa ảnh ${i+1}`);
}

function updateStatusCard(id) {
  const card = document.querySelector(`#box-${id}-0`)?.closest('.card');
  if (!card) return;
  const count = card.querySelectorAll('.img-box img').length;
  const statusEl = card.querySelector('.status');
  statusEl.className = 'status ' + (count === 4 ? 'full' : count === 0 ? 'empty' : 'lack');
  statusEl.textContent = count === 4 ? 'Đủ 4' : count === 0 ? 'Chưa có' : count + '/4';
}

function updateGlobalStats() {
  const cards = document.querySelectorAll('.card');
  let full = 0, partial = 0, empty = 0;
  cards.forEach(card => {
    const count = card.querySelectorAll('.img-box img').length;
    if (count === 4) full++;
    else if (count > 0) partial++;
    else empty++;
  });
  document.getElementById('total').textContent = cards.length;
  document.getElementById('full').textContent = full;
  document.getElementById('partial').textContent = partial;
  document.getElementById('empty').textContent = empty;
}

function copyPrompt(id) {
  const name = document.querySelector(`#box-${id}-0`)?.closest('.card')?.querySelector('.name')?.textContent || '';
  navigator.clipboard.writeText(name);
  showLog('Đã copy tên sản phẩm');
}

load(1);