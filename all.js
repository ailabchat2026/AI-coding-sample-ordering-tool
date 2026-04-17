/**
 * Tasty — 公司內部點餐工具 (v2: 餐廳 → 菜單 兩階段流程)
 *
 * 功能：
 * 1. Google Identity Services 登入
 * 2. Google Sheets API 讀取與寫入
 * 3. 權限控管 (Admin/Staff)
 * 4. 兩步驟點餐：先選餐廳 → 再選餐點
 */

// --- 設定 ---
const CONFIG = {
    CLIENT_ID: '291154632710-iff27p5atmn6eq6hmqrlh2o4int9bedr.apps.googleusercontent.com',
    SPREADSHEET_ID: '1hNr_0oxaQnXsBjO8w-OoCK1-Iku0nrTKFSkwO7DKReg',
    DISCOVERY_DOC: 'https://sheets.googleapis.com/$discovery/rest?version=v4',
    SCOPES: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid',
};

// --- 全域狀態 ---
let tokenClient;
let gapiInited = false;
let currentUser = null;
let state = {
    todayRestaurants: [],
    allMenu: [],
    selectedRestaurant: null,
    menuFilter: { keyword: '', category: 'all' },
    cart: [],
};

const SHEETS = {
    TODAY: 'TodayConfig',
    MENU: 'Menu',
    USERS: 'Users',
    ORDERS: 'Orders'
};

/**
 * 程式進入點
 */
document.addEventListener('DOMContentLoaded', () => {
    // 按鈕事件
    document.getElementById('sign-out-btn').addEventListener('click', handleSignOut);
    document.getElementById('btn-open-config').addEventListener('click', showConfigPanel);
    document.getElementById('btn-save-config').addEventListener('click', saveTodayConfig);
    document.getElementById('btn-clear-orders').addEventListener('click', clearOrders);
    document.getElementById('btn-show-orders').addEventListener('click', openOrdersModal);
    document.getElementById('btn-show-cart').addEventListener('click', openCartModal);
    document.getElementById('btn-confirm-cart').addEventListener('click', confirmCart);
    document.getElementById('btn-copy-orders').addEventListener('click', copyOrdersToClipboard);

    document.querySelectorAll('.close-cart-modal').forEach(b => b.addEventListener('click', closeCartModal));
    document.querySelector('#cart-modal .modal-backdrop').addEventListener('click', closeCartModal);
    document.getElementById('btn-back-restaurants').addEventListener('click', goToRestaurantsView);

    // 菜單搜尋
    const searchInput = document.getElementById('menu-search');
    const searchClear = document.getElementById('menu-search-clear');
    let searchDebounce = null;
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        searchClear.classList.toggle('hidden', val.length === 0);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
            state.menuFilter.keyword = val.trim().toLowerCase();
            renderMenuItems();
        }, 120);
    });
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.add('hidden');
        state.menuFilter.keyword = '';
        renderMenuItems();
        searchInput.focus();
    });

    document.querySelector('.close-modal').addEventListener('click', closeOrdersModal);
    document.querySelector('#orders-modal .modal-backdrop').addEventListener('click', closeOrdersModal);

    const loginBtn = document.getElementById('custom-login-btn');
    if (loginBtn) loginBtn.addEventListener('click', handleLoginClick);

    // Esc 關閉 modal
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!document.getElementById('orders-modal').classList.contains('hidden')) closeOrdersModal();
        if (!document.getElementById('cart-modal').classList.contains('hidden')) closeCartModal();
    });

    initGapiClient().then(() => {
        tryAutoLogin();
    }).catch(err => {
        console.error("GAPI init failed:", err);
        showLogin();
    });
});

// --- Google API 初始化 ---

async function handleLoginClick() {
    try {
        showLoading('正在連線…');
        await initGapiClient();
        const token = await requestAccessToken(true);
        await handleAuthFlow(token);
    } catch (err) {
        console.error("Login failed:", err);
        toast('登入失敗，請重試。', 'err');
        showLogin();
        hideLoading();
    }
}

async function tryAutoLogin() {
    const savedToken = loadTokenFromStorage();
    if (!savedToken) {
        showLogin();
        return;
    }
    gapi.client.setToken({ access_token: savedToken });
    try {
        await handleAuthFlow(savedToken);
    } catch (err) {
        console.warn("Auto login failed:", err);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXP_KEY);
        gapi.client.setToken('');
        showLogin();
        hideLoading();
    }
}

async function handleAuthFlow(accessToken) {
    showLoading('正在驗證身分並載入資料…');
    hideLogin();

    gapi.client.setToken({ access_token: accessToken });

    const profile = await fetchUserProfile(accessToken);
    if (!profile || !profile.email) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_EXP_KEY);
        gapi.client.setToken('');
        throw new Error("無法取得使用者資訊。");
    }

    const email = profile.email;
    const name = profile.name || email.split('@')[0];
    const userRole = await checkUserPermission(email);

    if (!userRole) {
        toast('您不在授權名單中，請聯繫管理員。', 'err');
        handleSignOut();
        return;
    }

    currentUser = { email, name, role: userRole };
    updateUIForUser();
    await loadAppArgs();
}

async function fetchUserProfile(accessToken) {
    try {
        const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!response.ok) throw new Error('Failed to fetch user profile');
        return await response.json();
    } catch (err) {
        console.error(err);
        return null;
    }
}

function initGapiClient() {
    return new Promise((resolve, reject) => {
        if (gapiInited) { resolve(); return; }
        gapi.load('client', async () => {
            try {
                await gapi.client.init({ discoveryDocs: [CONFIG.DISCOVERY_DOC] });
                gapiInited = true;
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
}

function requestAccessToken(forcePrompt = false) {
    return new Promise((resolve, reject) => {
        if (!forcePrompt) {
            const savedToken = loadTokenFromStorage();
            if (savedToken) {
                gapi.client.setToken({ access_token: savedToken });
                resolve(savedToken);
                return;
            }
        }

        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: (tokenResponse) => {
                if (tokenResponse && tokenResponse.access_token) {
                    saveTokenToStorage(tokenResponse);
                    resolve(tokenResponse.access_token);
                } else {
                    reject("Failed to get access token");
                }
            },
            error_callback: (err) => reject(err)
        });

        tokenClient.requestAccessToken({ prompt: forcePrompt ? 'consent' : '' });
    });
}

// --- Token Persistence ---
const TOKEN_KEY = 'google_access_token';
const TOKEN_EXP_KEY = 'google_token_expires_at';

function saveTokenToStorage(tokenResponse) {
    const expiresIn = tokenResponse.expires_in || 3599;
    const expiresAt = Date.now() + (expiresIn * 1000) - (5 * 60 * 1000);
    localStorage.setItem(TOKEN_KEY, tokenResponse.access_token);
    localStorage.setItem(TOKEN_EXP_KEY, expiresAt);
}

function loadTokenFromStorage() {
    const token = localStorage.getItem(TOKEN_KEY);
    const expiresAt = localStorage.getItem(TOKEN_EXP_KEY);
    if (!token || !expiresAt) return null;
    if (Date.now() < parseInt(expiresAt)) return token;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    return null;
}

function handleSignOut() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token);
        gapi.client.setToken('');
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);

    currentUser = null;
    state.selectedRestaurant = null;
    document.getElementById('user-info').classList.add('hidden');
    document.getElementById('app-section').classList.add('hidden');
    document.getElementById('order-summary-section').classList.add('hidden');
    showLogin();
}

// --- 業務邏輯 ---

async function checkUserPermission(email) {
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.USERS}!A:C`,
        });
        const rows = response.result.values;
        if (!rows || rows.length === 0) return null;
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][1] === email) return rows[i][2];
        }
        return null;
    } catch (err) {
        console.error("Error checking permission:", err);
        return null;
    }
}

async function loadAppArgs() {
    showLoading('載入餐廳與菜單中…');
    try {
        const [todayConfig, allMenu] = await Promise.all([
            getTodayRestaurants(),
            getAllMenu()
        ]);

        state.todayRestaurants = todayConfig;
        state.allMenu = allMenu;

        document.getElementById('today-restaurants').textContent =
            todayConfig.length > 0 ? `今日餐廳：${todayConfig.join('、')}` : '今日尚未設定餐廳';

        renderRestaurantList();
        goToRestaurantsView();

        hideLoading();
        document.getElementById('app-section').classList.remove('hidden');
    } catch (err) {
        console.error("Error loading app data:", err);
        toast('載入資料失敗，請檢查網路或 API 設定。', 'err');
        hideLoading();
    }
}

async function getTodayRestaurants() {
    const response = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${SHEETS.TODAY}!A:A`,
    });
    const rows = response.result.values;
    if (!rows || rows.length <= 1) return [];
    return rows.slice(1).map(row => row[0]).filter(val => val);
}

async function getAllMenu() {
    const response = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${SHEETS.MENU}!A:D`,
    });
    const rows = response.result.values;
    if (!rows || rows.length <= 1) return [];
    return rows.slice(1).map(row => ({
        restaurant: row[0],
        name: row[1],
        price: row[2],
        category: row[3]
    }));
}

// --- View Switching ---

function goToRestaurantsView() {
    state.selectedRestaurant = null;
    const app = document.getElementById('app-section');
    app.dataset.view = 'restaurants';
    document.getElementById('restaurants-view').classList.remove('hidden');
    document.getElementById('menu-section').classList.add('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToMenuView(restaurant) {
    state.selectedRestaurant = restaurant;
    const app = document.getElementById('app-section');
    app.dataset.view = 'menu';
    document.getElementById('restaurants-view').classList.add('hidden');
    document.getElementById('menu-section').classList.remove('hidden');
    document.getElementById('current-restaurant-name').textContent = restaurant;
    renderMenu(restaurant);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Renderers ---

function renderRestaurantList() {
    const container = document.getElementById('restaurant-list');
    const desc = document.getElementById('restaurants-desc');
    container.innerHTML = '';

    if (state.todayRestaurants.length === 0) {
        desc.textContent = '今日尚未設定餐廳，請聯繫管理員。';
        container.innerHTML = `
            <div class="empty">
                <svg class="icon icon-lg" style="margin:0 auto;color:var(--muted)"><use href="#i-store" /></svg>
                <h3>尚未開放餐廳</h3>
                <p>請管理員在上方設定今日開放的餐廳。</p>
            </div>`;
        return;
    }

    desc.textContent = `共 ${state.todayRestaurants.length} 間餐廳開放中，選一間開始點餐。`;

    state.todayRestaurants.forEach(r => {
        const count = state.allMenu.filter(m => m.restaurant === r).length;
        const btn = document.createElement('button');
        btn.className = 'restaurant-card';
        btn.type = 'button';
        btn.setAttribute('aria-label', `選擇餐廳 ${r}，查看 ${count} 道餐點`);
        btn.innerHTML = `
            <div class="rc-top">
                <span class="rc-icon" aria-hidden="true">
                    <svg class="icon icon-lg"><use href="#i-bowl" /></svg>
                </span>
                <span class="rc-badge">OPEN</span>
            </div>
            <h3 class="rc-name">${escapeHtml(r)}</h3>
            <div class="rc-meta">
                <span>${count} 道餐點</span>
                <span class="rc-cta">
                    查看菜單
                    <svg class="icon icon-sm"><use href="#i-chevron" /></svg>
                </span>
            </div>
        `;
        btn.addEventListener('click', () => goToMenuView(r));
        container.appendChild(btn);
    });
}

function renderMenu(restaurant) {
    // 切換餐廳時重置過濾器
    state.menuFilter = { keyword: '', category: 'all' };
    const searchInput = document.getElementById('menu-search');
    if (searchInput) searchInput.value = '';
    document.getElementById('menu-search-clear').classList.add('hidden');

    const items = state.allMenu.filter(item => item.restaurant === restaurant);
    const toolbar = document.getElementById('menu-toolbar');
    toolbar.classList.toggle('hidden', items.length === 0);

    renderCategoryFilter(items);
    renderMenuItems();
}

function renderCategoryFilter(items) {
    const container = document.getElementById('menu-categories');
    container.innerHTML = '';

    // 收集分類（保留原始順序）
    const seen = new Set();
    const cats = [];
    items.forEach(i => {
        const c = (i.category || '').trim() || '其他';
        if (!seen.has(c)) { seen.add(c); cats.push(c); }
    });

    // 分類 ≤ 1 就不用顯示
    if (cats.length <= 1) {
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');

    const makeChip = (key, label, count) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cat-chip' + (state.menuFilter.category === key ? ' active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', state.menuFilter.category === key ? 'true' : 'false');
        btn.dataset.cat = key;
        btn.innerHTML = `<span>${escapeHtml(label)}</span><span class="cat-count">${count}</span>`;
        btn.addEventListener('click', () => {
            state.menuFilter.category = key;
            container.querySelectorAll('.cat-chip').forEach(c => {
                const active = c.dataset.cat === key;
                c.classList.toggle('active', active);
                c.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            renderMenuItems();
        });
        return btn;
    };

    container.appendChild(makeChip('all', '全部', items.length));
    cats.forEach(c => {
        const count = items.filter(i => ((i.category || '').trim() || '其他') === c).length;
        container.appendChild(makeChip(c, c, count));
    });
}

function renderMenuItems() {
    const restaurant = state.selectedRestaurant;
    const container = document.getElementById('menu-container');
    const countEl = document.getElementById('menu-count');
    container.innerHTML = '';

    const all = state.allMenu.filter(item => item.restaurant === restaurant);
    const { keyword, category } = state.menuFilter;

    const items = all.filter(item => {
        const cat = (item.category || '').trim() || '其他';
        if (category !== 'all' && cat !== category) return false;
        if (keyword) {
            const haystack = (item.name + ' ' + cat).toLowerCase();
            if (!haystack.includes(keyword)) return false;
        }
        return true;
    });

    countEl.textContent = items.length;

    if (all.length === 0) {
        container.innerHTML = `
            <div class="empty">
                <h3>這間餐廳尚未提供菜單</h3>
                <p>請聯繫管理員在試算表中加入餐點。</p>
            </div>`;
        return;
    }

    if (items.length === 0) {
        container.innerHTML = `
            <div class="empty">
                <h3>找不到符合的餐點</h3>
                <p>試試其他關鍵字或切換分類。</p>
            </div>`;
        return;
    }

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'menu-item';
        card.innerHTML = `
            <h4>${escapeHtml(item.name)}</h4>
            <div class="category">${escapeHtml(item.category || '餐點')}</div>
            <div class="price">NT$ ${escapeHtml(item.price)}</div>
            <div class="row-action">
                <input type="text" class="note-input" placeholder="備註（例：少冰、不要香菜）" maxlength="60">
                <button class="btn-order">加入訂單</button>
            </div>
        `;
        const btn = card.querySelector('.btn-order');
        btn.textContent = '加入購物車';
        btn.addEventListener('click', () => {
            const note = card.querySelector('.note-input').value.trim();
            addToCart(item.restaurant, item.name, item.price, note, btn);
            card.querySelector('.note-input').value = '';
        });
        container.appendChild(card);
    });
}

// --- 購物車 ---

function addToCart(restaurant, name, price, note, btnElement) {
    state.cart.push({ id: Date.now() + Math.random(), restaurant, name, price, note });
    updateCartBadge();

    btnElement.disabled = true;
    btnElement.textContent = '已加入 ✓';
    setTimeout(() => {
        btnElement.disabled = false;
        btnElement.textContent = '加入購物車';
    }, 800);

    toast(`已加入購物車：${name}`, 'ok');
}

function updateCartBadge() {
    const badge = document.getElementById('cart-badge');
    const count = state.cart.length;
    badge.textContent = count;
    badge.classList.toggle('hidden', count === 0);
}

function openCartModal() {
    renderCartItems();
    document.getElementById('cart-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeCartModal() {
    document.getElementById('cart-modal').classList.add('hidden');
    document.body.style.overflow = '';
}

function renderCartItems() {
    const body = document.getElementById('cart-body');
    const confirmBtn = document.getElementById('btn-confirm-cart');
    const totalEl = document.getElementById('cart-total');

    if (state.cart.length === 0) {
        body.innerHTML = `<div class="empty" style="border:none;padding:40px 24px">
            <h3>購物車是空的</h3>
            <p>回菜單選擇餐點，點「加入購物車」。</p>
        </div>`;
        confirmBtn.disabled = true;
        totalEl.textContent = '0';
        return;
    }

    const total = state.cart.reduce((sum, item) => sum + (parseInt(item.price) || 0), 0);
    totalEl.textContent = total;
    confirmBtn.disabled = false;

    const ul = document.createElement('ul');
    ul.className = 'cart-list';

    state.cart.forEach(item => {
        const li = document.createElement('li');
        li.className = 'cart-item';
        const metaParts = [escapeHtml(item.restaurant)];
        if (item.note) metaParts.push(escapeHtml(item.note));
        li.innerHTML = `
            <div class="cart-item-info">
                <span class="cart-item-name">${escapeHtml(item.name)}</span>
                <span class="cart-item-meta">${metaParts.join(' · ')}</span>
            </div>
            <span class="cart-item-price">NT$ ${escapeHtml(String(item.price))}</span>
            <button class="icon-btn" aria-label="移除 ${escapeHtml(item.name)}" style="color:var(--danger)">
                <svg class="icon icon-sm"><use href="#i-trash" /></svg>
            </button>
        `;
        li.querySelector('.icon-btn').addEventListener('click', () => {
            state.cart = state.cart.filter(c => c.id !== item.id);
            updateCartBadge();
            renderCartItems();
        });
        ul.appendChild(li);
    });

    body.innerHTML = '';
    body.appendChild(ul);
}

async function confirmCart() {
    if (state.cart.length === 0) return;

    const btn = document.getElementById('btn-confirm-cart');
    btn.disabled = true;
    btn.textContent = '送出中…';

    const timestamp = new Date().toLocaleString('zh-TW', { hour12: false });
    const values = state.cart.map(item => [
        timestamp, currentUser.email, item.restaurant, item.name, item.price, item.note
    ]);

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.ORDERS}!A:F`,
            valueInputOption: 'USER_ENTERED',
            resource: { values }
        });

        const count = state.cart.length;
        state.cart = [];
        updateCartBadge();
        closeCartModal();
        toast(`已成功送出 ${count} 筆訂單！`, 'ok');
    } catch (err) {
        console.error('Cart submit failed', err);
        toast('送出失敗，請重試。', 'err');
        btn.disabled = false;
        btn.innerHTML = `<svg class="icon icon-sm"><use href="#i-check" /></svg> 確認送出`;
    }
}

// --- 管理員功能 ---

async function showConfigPanel() {
    const panel = document.getElementById('admin-config-panel');
    const container = document.getElementById('restaurant-checkboxes');
    panel.classList.toggle('hidden');
    if (panel.classList.contains('hidden')) return;

    container.innerHTML = '<span class="chip">讀取中…</span>';
    try {
        const allMenu = state.allMenu.length ? state.allMenu : await getAllMenu();
        const restaurants = [...new Set(allMenu.map(item => item.restaurant).filter(Boolean))];

        container.innerHTML = '';
        restaurants.forEach(r => {
            const isChecked = state.todayRestaurants.includes(r);
            const label = document.createElement('label');
            label.className = 'chip' + (isChecked ? ' checked' : '');
            label.innerHTML = `
                <input type="checkbox" value="${escapeHtml(r)}" name="restaurant-select" ${isChecked ? 'checked' : ''}>
                <span>${escapeHtml(r)}</span>
            `;
            const input = label.querySelector('input');
            input.addEventListener('change', () => {
                label.classList.toggle('checked', input.checked);
            });
            container.appendChild(label);
        });
    } catch (err) {
        container.innerHTML = '<span class="chip">載入餐廳失敗</span>';
    }
}

async function saveTodayConfig() {
    const checkboxes = document.querySelectorAll('input[name="restaurant-select"]:checked');
    const selected = Array.from(checkboxes).map(cb => cb.value);

    if (selected.length === 0) {
        if (!confirm('確定不選擇任何餐廳嗎？(將清空今日設定)')) return;
    }

    try {
        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.TODAY}!A2:A`
        });

        if (selected.length > 0) {
            const values = selected.map(r => [r]);
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: CONFIG.SPREADSHEET_ID,
                range: `${SHEETS.TODAY}!A2`,
                valueInputOption: 'USER_ENTERED',
                resource: { values }
            });
        }

        toast('設定已儲存！', 'ok');
        document.getElementById('admin-config-panel').classList.add('hidden');
        loadAppArgs();
    } catch (err) {
        console.error(err);
        toast('儲存失敗', 'err');
    }
}

async function clearOrders() {
    if (!confirm('⚠️ 確定要清空今日所有訂單資料嗎？此動作無法復原！')) return;
    try {
        await gapi.client.sheets.spreadsheets.values.clear({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.ORDERS}!A2:F`
        });
        toast('訂單已清空。', 'ok');
    } catch (err) {
        console.error(err);
        toast('清空失敗', 'err');
    }
}

// --- 訂單 Modal ---

async function openOrdersModal() {
    const modal = document.getElementById('orders-modal');
    const tbody = document.getElementById('orders-list');
    const totalSpan = document.getElementById('total-amount');

    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted)">載入中…</td></tr>';
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `${SHEETS.ORDERS}!A2:F`,
        });

        const rows = response.result.values || [];
        tbody.innerHTML = '';

        if (rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">目前尚無訂單</td></tr>';
            totalSpan.textContent = '0';
            return;
        }

        let total = 0;
        rows.forEach(row => {
            const price = parseInt(row[4]) || 0;
            total += price;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHtml(row[0] || '')}</td>
                <td>${escapeHtml((row[1] || '').split('@')[0])}</td>
                <td>${escapeHtml(row[2] || '')}</td>
                <td>${escapeHtml(row[3] || '')}</td>
                <td class="num">${escapeHtml(row[4] || '0')}</td>
                <td>${escapeHtml(row[5] || '')}</td>
            `;
            tbody.appendChild(tr);
        });

        totalSpan.textContent = total;
    } catch (err) {
        console.error(err);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--danger)">載入失敗</td></tr>';
    }
}

function closeOrdersModal() {
    document.getElementById('orders-modal').classList.add('hidden');
    document.body.style.overflow = '';
}

function copyOrdersToClipboard() {
    const rows = document.querySelectorAll('#orders-list tr');
    let text = "📋 今日點餐清單：\n\n";

    rows.forEach(row => {
        const cols = row.querySelectorAll('td');
        if (cols.length < 5) return;
        const user = cols[1].textContent;
        const restaurant = cols[2].textContent;
        const food = cols[3].textContent;
        const price = cols[4].textContent;
        const note = cols[5] && cols[5].textContent ? `(${cols[5].textContent})` : '';
        text += `[${restaurant}] ${food} $${price} - ${user} ${note}\n`;
    });

    const total = document.getElementById('total-amount').textContent;
    text += `\n💰 總金額：${total} 元`;

    navigator.clipboard.writeText(text).then(
        () => toast('已複製到剪貼簿！', 'ok'),
        () => toast('複製失敗，請手動複製。', 'err')
    );
}

// --- UI Helpers ---

function showLoading(msg) {
    document.getElementById('status-section').classList.remove('hidden');
    document.getElementById('status-text').textContent = msg || '載入中…';
}

function hideLoading() {
    document.getElementById('status-section').classList.add('hidden');
}

function showLogin() {
    document.getElementById('login-section').classList.remove('hidden');
    document.getElementById('app-section').classList.add('hidden');
}

function hideLogin() {
    document.getElementById('login-section').classList.add('hidden');
}

function updateUIForUser() {
    document.getElementById('user-info').classList.remove('hidden');
    document.getElementById('user-name').textContent = `${currentUser.name} · ${currentUser.role}`;

    if (currentUser.role === '管理員') {
        document.getElementById('admin-section').classList.remove('hidden');
    } else {
        document.getElementById('admin-section').classList.add('hidden');
    }

    document.getElementById('order-summary-section').classList.remove('hidden');
}

// Toast 提示
let toastTimer = null;
function toast(msg, type = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast ' + type;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// XSS 防護
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
