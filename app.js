import { isSupabaseConfigured, supabase } from './supabaseClient.js';

// Default Menu Dataset extracted directly from Newform Multi Cuisine Restaurant Menu Cards
const DEFAULT_MENU = [
  // --- MANDHI & RICE ---
  {
    id: "m1",
    name: "Chicken Mandhi",
    category: "mandhi",
    diet: "non-veg",
    tag: "Bestseller",
    description: "Authentic Arabian spiced basmati rice slow cooked with juicy tender chicken.",
    image: "assets/mandhi.png",
    portionType: "multi",
    prices: { quarter: 240, half: 420, full: 740 }
  },
  {
    id: "m2",
    name: "Alfaham Chicken Mandhi",
    category: "mandhi",
    diet: "non-veg",
    tag: "Chef Special",
    description: "Charcoal grilled Alfaham chicken served over flavorful Mandhi rice.",
    image: "assets/mandhi.png",
    portionType: "multi",
    prices: { quarter: 260, half: 500, full: 950 }
  },
  {
    id: "m3",
    name: "Shawaya Chicken Mandhi",
    category: "mandhi",
    diet: "non-veg",
    tag: "",
    description: "Rotisserie grilled Shawaya chicken paired with aromatic Mandhi rice.",
    image: "assets/mandhi.png",
    portionType: "multi",
    prices: { quarter: 260, half: 500, full: 950 }
  },
  {
    id: "m4",
    name: "Beef Ribs Mandhi",
    category: "mandhi",
    diet: "non-veg",
    tag: "Special",
    description: "Succulent braised beef ribs served on bed of aromatic Mandhi rice.",
    image: "assets/mandhi.png",
    portionType: "multi",
    prices: { quarter: 260, half: 500, full: 950 }
  },
  {
    id: "m5",
    name: "Pothinkal Mandhi (2 Persons)",
    category: "mandhi",
    diet: "non-veg",
    tag: "House Special",
    description: "Special Kerala style buffalo leg roast Mandhi cooked for two.",
    image: "assets/mandhi.png",
    portionType: "single",
    price: 900
  },

  // --- BROAST / ALFAHAM / TANDOOR ---
  {
    id: "a1",
    name: "Alfaham Chicken",
    category: "broast_alfaham",
    diet: "non-veg",
    tag: "Bestseller",
    description: "Traditional Arabian charcoal grilled chicken with toum garlic sauce.",
    image: "assets/alfaham.png",
    portionType: "multi",
    prices: { quarter: 140, half: 280, full: 550 }
  },
  {
    id: "a2",
    name: "Peri Peri Alfaham",
    category: "broast_alfaham",
    diet: "non-veg",
    tag: "Spicy",
    description: "Fiery African bird eye chili marinated grilled chicken.",
    image: "assets/alfaham.png",
    portionType: "multi",
    prices: { quarter: 150, half: 300, full: 580 }
  },

  // --- BEEF SPECIALS ---
  {
    id: "b1",
    name: "Beef Fry (Ularthiyathu)",
    category: "beef",
    diet: "non-veg",
    tag: "Bestseller",
    description: "Authentic Wayanad style beef fry cooked with coconut chips & curry leaves.",
    image: "assets/beeffry.png",
    portionType: "single",
    price: 140
  },
  {
    id: "b2",
    name: "Beef Chilly",
    category: "beef",
    diet: "non-veg",
    tag: "Spicy",
    description: "Wok tossed beef slices with capsicum, onion & dark soy chili glaze.",
    image: "assets/beeffry.png",
    portionType: "single",
    price: 160
  },

  // --- CHICKEN CURRIES & CHINESE ---
  {
    id: "c1",
    name: "Butter Chicken",
    category: "chicken",
    diet: "non-veg",
    tag: "Popular",
    description: "Rich buttery tomato cream gravy with tandoori chicken tikka.",
    image: "assets/hero.png",
    portionType: "multi",
    prices: { quarter: 260, half: 400, full: 600 }
  },

  // --- SEAFOOD & PRAWNS ---
  {
    id: "s1",
    name: "Prawns Varattu",
    category: "seafood",
    diet: "non-veg",
    tag: "Bestseller",
    description: "Kerala style dry spicy prawn roast with coconut chips.",
    image: "assets/beeffry.png",
    portionType: "single",
    price: 300
  },

  // --- VEGETARIAN ---
  {
    id: "v1",
    name: "Paneer Butter Masala",
    category: "veg",
    diet: "veg",
    tag: "Bestseller",
    description: "Cottage cheese cubes simmered in rich creamy tomato butter gravy.",
    image: "assets/hero.png",
    portionType: "single",
    price: 220
  }
];

// App State Management
let menuItems = [];
let cart = [];
let activeCategory = 'all';
let activeDiet = 'all';
let searchQuery = '';
let selectedPortions = {};
let isAdmin = false;
let editingItemId = null;

// LocalStorage Keys
const CART_STORAGE_KEY = 'newform_cart_v1';
const THEME_STORAGE_KEY = 'newform_theme_v1';

// Theme Management Functions
function initTheme() {
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
  setTheme(savedTheme);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  
  const themeIcon = document.getElementById('themeIcon');
  const themeIconMobile = document.getElementById('themeIconMobile');
  
  if (theme === 'light') {
    if (themeIcon) themeIcon.className = 'fa-solid fa-sun';
    if (themeIconMobile) themeIconMobile.className = 'fa-solid fa-sun';
  } else {
    if (themeIcon) themeIcon.className = 'fa-solid fa-moon';
    if (themeIconMobile) themeIconMobile.className = 'fa-solid fa-moon';
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
  showToast(newTheme === 'light' ? '☀️ Minimalist Light Theme Activated' : '🌙 Monochrome White & Obsidian Theme Activated');
}

// Initialize App
document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await checkAdminState();
  await loadMenuData();
  loadCartData();
  setupEventListeners();
  renderMenu();
  updateCartBadge();
  registerServiceWorker();
});

// Admin Security Management
async function checkAdminState() {
  if (!isSupabaseConfigured) {
    updateAdminUI();
    return;
  }
  const { data: { session } } = await supabase.auth.getSession();
  await refreshAdminState(session);
  
  // Listen for auth changes
  supabase.auth.onAuthStateChange((event, session) => {
    // Supabase advises against awaiting inside this callback.
    setTimeout(() => refreshAdminState(session), 0);
  });
}

async function refreshAdminState(session) {
  isAdmin = false;
  if (session) {
    const { data, error } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', session.user.id)
      .maybeSingle();
    isAdmin = !error && data?.role === 'admin';
  }
  updateAdminUI();
  renderMenu();
}

function updateAdminUI() {
  const adminElements = document.querySelectorAll('.admin-only-element');
  adminElements.forEach(el => {
    el.style.display = isAdmin ? 'inline-flex' : 'none';
  });

  const adminToggleTextFooter = document.getElementById('adminToggleBtnFooter');

  if (isAdmin) {
    if (adminToggleTextFooter) adminToggleTextFooter.innerHTML = '<i class="fa-solid fa-right-from-bracket"></i> LOG OUT ADMIN';
  } else {
    if (adminToggleTextFooter) adminToggleTextFooter.innerHTML = '<i class="fa-solid fa-lock"></i> STAFF ADMIN';
  }
}

function openAdminLoginModal() {
  document.getElementById('overlay').classList.add('active');
  document.getElementById('adminLoginModal').classList.add('active');
  const emailInput = document.getElementById('adminEmailInput');
  const passInput = document.getElementById('adminPasswordInput');
  if (emailInput) emailInput.value = '';
  if (passInput) passInput.value = '';
  document.getElementById('authErrorMsg').style.display = 'none';
}

function closeAdminLoginModal() {
  document.getElementById('overlay').classList.remove('active');
  document.getElementById('adminLoginModal').classList.remove('active');
}

function openAboutModal() {
  document.getElementById('overlay').classList.add('active');
  document.getElementById('aboutModal').classList.add('active');
}

function closeAboutModal() {
  document.getElementById('aboutModal').classList.remove('active');
  document.getElementById('overlay').classList.remove('active');
}

function openContactModal() {
  document.getElementById('overlay').classList.add('active');
  document.getElementById('contactModal').classList.add('active');
}

function closeContactModal() {
  document.getElementById('contactModal').classList.remove('active');
  document.getElementById('overlay').classList.remove('active');
}

async function handleAdminLogin() {
  if (!isSupabaseConfigured) {
    showAuthError('Supabase is not configured. Add the GitHub Pages repository variables first.');
    return;
  }
  const email = document.getElementById('adminEmailInput').value.trim();
  const password = document.getElementById('adminPasswordInput').value.trim();

  if (!email || !password) return;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    showAuthError(error.message);
  } else {
    closeAdminLoginModal();
    showToast('🔑 Admin Profile Verified & Unlocked!');
  }
}

async function handleAdminLogout() {
  if (confirm('Logout from Admin Profile?')) {
    await supabase.auth.signOut();
    showToast('Logged out of Admin Profile');
  }
}

function showAuthError(message) {
  const errorMsg = document.getElementById('authErrorMsg');
  errorMsg.textContent = message;
  errorMsg.style.display = 'block';
}

// Load Menu Data from Supabase
async function loadMenuData() {
  if (!isSupabaseConfigured) {
    menuItems = [...DEFAULT_MENU];
    initializePortions();
    renderMenu();
    return;
  }
  const { data, error } = await supabase.from('menu_items').select('*');
  
  if (error || !data || data.length === 0) {
    // Keep the public menu usable during first-time database setup.
    menuItems = [...DEFAULT_MENU];
    if (error) console.error('Could not load menu from Supabase:', error.message);
  } else {
    // Normalize: parse pricesJSON into a prices object
    menuItems = data.map(item => {
      if (item.pricesJSON && typeof item.pricesJSON === 'string') {
        try { item.prices = JSON.parse(item.pricesJSON); } catch(e) { /* ignore */ }
      } else if (item.pricesJSON && typeof item.pricesJSON === 'object') {
        item.prices = item.pricesJSON;
      }
      return item;
    });
  }

  initializePortions();
  renderMenu();
}

function initializePortions() {
  menuItems.forEach(item => {
    if (item.portionType === 'multi') {
      selectedPortions[item.id] = 'quarter';
    }
  });
  
}

function loadCartData() {
  const saved = localStorage.getItem(CART_STORAGE_KEY);
  if (saved) {
    try {
      cart = JSON.parse(saved);
    } catch(e) {
      cart = [];
    }
  }
}

function saveCartData() {
  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

// Event Listeners Setup
function setupEventListeners() {
  // Theme Toggle Event Listeners
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeToggleBtnMobile = document.getElementById('themeToggleBtnMobile');

  if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);
  if (themeToggleBtnMobile) themeToggleBtnMobile.addEventListener('click', toggleTheme);

  // Admin Login Buttons
  const adminToggleBtnFooter = document.getElementById('adminToggleBtnFooter');
  const aboutBtnNav = document.getElementById('aboutBtnNav');
  const contactBtnNav = document.getElementById('contactBtnNav');
  const closeAboutModalBtn = document.getElementById('closeAboutModalBtn');
  const closeContactModalBtn = document.getElementById('closeContactModalBtn');
  const closeAdminModalBtn = document.getElementById('closeAdminModalBtn');
  const submitAdminAuthBtn = document.getElementById('submitAdminAuthBtn');

  if (adminToggleBtnFooter) {
    adminToggleBtnFooter.addEventListener('click', () => {
      if (isAdmin) handleAdminLogout();
      else openAdminLoginModal();
    });
  }

  if (aboutBtnNav) aboutBtnNav.addEventListener('click', openAboutModal);
  if (contactBtnNav) contactBtnNav.addEventListener('click', openContactModal);
  if (closeAboutModalBtn) closeAboutModalBtn.addEventListener('click', closeAboutModal);
  if (closeContactModalBtn) closeContactModalBtn.addEventListener('click', closeContactModal);

  if (closeAdminModalBtn) closeAdminModalBtn.addEventListener('click', closeAdminLoginModal);
  if (submitAdminAuthBtn) submitAdminAuthBtn.addEventListener('click', handleAdminLogin);

  const adminPasswordInput = document.getElementById('adminPasswordInput');
  if (adminPasswordInput) {
    adminPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleAdminLogin();
    });
  }

  // Category Scroll Tabs
  document.querySelectorAll('.cat-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');
      activeCategory = target.dataset.category;
      renderMenu();
    });
  });

  const categoryScroll = document.getElementById('categoryScroll');
  const categoryScrollPrev = document.getElementById('categoryScrollPrev');
  const categoryScrollNext = document.getElementById('categoryScrollNext');
  if (categoryScroll && categoryScrollPrev && categoryScrollNext) {
    const categoryScrollStep = () => Math.max(180, Math.round(categoryScroll.clientWidth * 0.72));
    const updateCategoryScrollControls = () => {
      const maxScrollLeft = categoryScroll.scrollWidth - categoryScroll.clientWidth;
      categoryScrollPrev.disabled = categoryScroll.scrollLeft <= 1;
      categoryScrollNext.disabled = categoryScroll.scrollLeft >= maxScrollLeft - 1;
    };

    categoryScrollPrev.addEventListener('click', () => {
      categoryScroll.scrollBy({ left: -categoryScrollStep(), behavior: 'smooth' });
    });
    categoryScrollNext.addEventListener('click', () => {
      categoryScroll.scrollBy({ left: categoryScrollStep(), behavior: 'smooth' });
    });
    categoryScroll.addEventListener('scroll', updateCategoryScrollControls, { passive: true });
    window.addEventListener('resize', updateCategoryScrollControls);
    updateCategoryScrollControls();
  }

  // Diet Filter Buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');
      activeDiet = target.dataset.diet;
      renderMenu();
    });
  });

  // Search Input
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      renderMenu();
    });
  }

  // Drawer / Modals UI
  const cartBtn = document.getElementById('cartBtn');
  const cartBtnMobile = document.getElementById('cartBtnMobile');
  const closeCartBtn = document.getElementById('closeCartBtn');
  const overlay = document.getElementById('overlay');

  if (cartBtn) cartBtn.addEventListener('click', openCart);
  if (cartBtnMobile) cartBtnMobile.addEventListener('click', openCart);
  if (closeCartBtn) closeCartBtn.addEventListener('click', closeCart);
  if (overlay) overlay.addEventListener('click', closeAllModals);

  // Menu cards are re-rendered, so use one delegated listener for admin actions.
  const foodGrid = document.getElementById('foodGrid');
  if (foodGrid) {
    foodGrid.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-menu-action]');
      if (!actionButton) return;

      const { menuAction, itemId } = actionButton.dataset;
      if (!itemId) return;
      event.preventDefault();
      event.stopPropagation();

      if (menuAction === 'edit') window.editItem(itemId);
      if (menuAction === 'remove') window.deleteItem(itemId);
    });
  }

  // Add Item Modal Buttons (Admin Protected)
  const addItemBtn = document.getElementById('addItemBtn');
  const addItemBtnMobile = document.getElementById('addItemBtnMobile');
  const closeAddModalBtn = document.getElementById('closeAddModalBtn');

  if (addItemBtn) addItemBtn.addEventListener('click', triggerAddItem);
  if (addItemBtnMobile) addItemBtnMobile.addEventListener('click', triggerAddItem);
  if (closeAddModalBtn) closeAddModalBtn.addEventListener('click', closeAddItemModal);

  // Form Submit for Add Item
  const addItemForm = document.getElementById('addItemForm');
  if (addItemForm) {
    addItemForm.addEventListener('submit', handleAddItemSubmit);
  }

  // Portion Type Toggle in Form
  const portionTypeSelect = document.getElementById('formPortionType');
  if (portionTypeSelect) {
    portionTypeSelect.addEventListener('change', (e) => {
      const singleGroup = document.getElementById('singlePriceGroup');
      const multiGroup = document.getElementById('multiPriceGroup');
      if (e.target.value === 'single') {
        singleGroup.style.display = 'block';
        multiGroup.style.display = 'none';
      } else {
        singleGroup.style.display = 'none';
        multiGroup.style.display = 'grid';
      }
    });
  }

  // WhatsApp Checkout
  const whatsappCheckoutBtn = document.getElementById('whatsappCheckoutBtn');
  if (whatsappCheckoutBtn) {
    whatsappCheckoutBtn.addEventListener('click', processWhatsAppOrder);
  }
}

function triggerAddItem() {
  if (!isAdmin) {
    openAdminLoginModal();
  } else {
    openAddItemModal();
  }
}

// Render Menu Cards
function renderMenu() {
  const container = document.getElementById('foodGrid');
  const countEl = document.getElementById('itemCount');
  if (!container) return;

  // Filter Items
  const filtered = menuItems.filter(item => {
    const matchesCat = (activeCategory === 'all') || (item.category === activeCategory);
    const matchesDiet = (activeDiet === 'all') || (item.diet === activeDiet);
    const matchesSearch = item.name.toLowerCase().includes(searchQuery) ||
                          (item.description || '').toLowerCase().includes(searchQuery);
    return matchesCat && matchesDiet && matchesSearch;
  });

  if (countEl) countEl.textContent = `${filtered.length} DISHES`;

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:60px 20px; color:var(--text-muted); grid-column:1/-1;">
        <i class="fa-solid fa-utensils" style="font-size:2.5rem; margin-bottom:12px;"></i>
        <h3>No dishes found</h3>
        <p>Try searching for another dish.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(item => {
    const currentPortion = selectedPortions[item.id] || 'quarter';
    let currentPrice = item.price;
    if (item.portionType === 'multi' && item.prices) {
      currentPrice = item.prices[currentPortion] || item.prices.quarter;
    }

    return `
      <div class="food-card${isAdmin ? ' admin-mode' : ''}" id="card-${item.id}">
        <div class="card-img-container">
          <img src="${item.image || 'assets/hero.png'}" alt="${item.name}" class="card-img" onerror="this.src='assets/hero.png'">
          <div class="diet-icon ${item.diet}"></div>
          ${item.tag ? `<span class="card-badge">${item.tag}</span>` : ''}
          ${isAdmin ? `
            <div class="card-admin-controls" aria-label="Admin item controls">
              <button type="button" class="admin-card-action admin-edit-item-btn" data-menu-action="edit" data-item-id="${item.id}" title="Edit ${item.name}" aria-label="Edit ${item.name}">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button type="button" class="admin-card-action admin-remove-item-btn" data-menu-action="remove" data-item-id="${item.id}" title="Remove ${item.name}" aria-label="Remove ${item.name}">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
          ` : ''}
        </div>
        <div class="card-body">
          <h3 class="food-name">${item.name}</h3>
          <p class="food-desc">${item.description || ''}</p>
          
          ${item.portionType === 'multi' ? `
            <div class="portion-selector">
              <button class="portion-btn ${currentPortion === 'quarter' ? 'active' : ''}" onclick="selectPortion('${item.id}', 'quarter')">Qtr (₹${item.prices.quarter})</button>
              <button class="portion-btn ${currentPortion === 'half' ? 'active' : ''}" onclick="selectPortion('${item.id}', 'half')">Half (₹${item.prices.half})</button>
              <button class="portion-btn ${currentPortion === 'full' ? 'active' : ''}" onclick="selectPortion('${item.id}', 'full')">Full (₹${item.prices.full})</button>
            </div>
          ` : ''}

          <div class="card-footer">
            <div class="price-display">
              <span class="price-amount">₹${currentPrice}</span>
            </div>
            <button class="add-cart-btn" onclick="addToCart('${item.id}')">
              + ADD
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Portion Selection Handler
window.selectPortion = function(itemId, portion) {
  selectedPortions[itemId] = portion;
  renderMenu();
};

// Add to Cart
window.addToCart = function(itemId) {
  const item = menuItems.find(i => i.id === itemId);
  if (!item) return;

  const portion = item.portionType === 'multi' ? (selectedPortions[itemId] || 'quarter') : 'single';
  let price = item.price;
  if (item.portionType === 'multi' && item.prices) {
    price = item.prices[portion];
  }

  const cartId = `${itemId}_${portion}`;
  const existing = cart.find(c => c.cartId === cartId);

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      cartId,
      id: item.id,
      name: item.name,
      portion: portion !== 'single' ? portion.toUpperCase() : '',
      price: price,
      quantity: 1,
      image: item.image
    });
  }

  saveCartData();
  updateCartBadge();
  showToast(`Added ${item.name} (${portion !== 'single' ? portion.toUpperCase() : ''}) to cart`);
};

// Update Cart Badge
function updateCartBadge() {
  const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const badge1 = document.getElementById('cartBadge');
  if (badge1) badge1.textContent = totalCount;
}

// Render Cart Drawer Contents
function renderCart() {
  const cartBody = document.getElementById('cartBody');
  const subtotalEl = document.getElementById('cartSubtotal');
  const taxEl = document.getElementById('cartTax');
  const totalEl = document.getElementById('cartTotal');

  if (!cartBody) return;

  if (cart.length === 0) {
    cartBody.innerHTML = `
      <div style="text-align:center; padding:40px 0; color:var(--text-muted);">
        <i class="fa-solid fa-basket-shopping" style="font-size:2.5rem; margin-bottom:12px;"></i>
        <p>Your cart is empty.</p>
      </div>
    `;
    if (subtotalEl) subtotalEl.textContent = '₹0';
    if (taxEl) taxEl.textContent = '₹0';
    if (totalEl) totalEl.textContent = '₹0';
    return;
  }

  cartBody.innerHTML = cart.map((item, idx) => `
    <div class="cart-item">
      <div class="cart-item-details">
        <div style="font-family:var(--font-heading); font-weight:700; font-size:0.95rem;">${item.name}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${item.portion ? `Portion: ${item.portion} | ` : ''}₹${item.price} each</div>
        <div style="font-weight:700; color:var(--primary); font-size:0.9rem;">₹${item.price * item.quantity}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px; background:var(--bg-primary); padding:4px 8px; border-radius:4px;">
        <button onclick="updateCartQty(${idx}, -1)" style="background:none; border:none; cursor:pointer; font-weight:bold;">-</button>
        <span>${item.quantity}</span>
        <button onclick="updateCartQty(${idx}, 1)" style="background:none; border:none; cursor:pointer; font-weight:bold;">+</button>
      </div>
    </div>
  `).join('');

  const subtotal = cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
  const gst = Math.round(subtotal * 0.05); // 5% GST
  const total = subtotal + gst;

  if (subtotalEl) subtotalEl.textContent = `₹${subtotal}`;
  if (taxEl) taxEl.textContent = `₹${gst}`;
  if (totalEl) totalEl.textContent = `₹${total}`;
}

window.updateCartQty = function(index, delta) {
  if (cart[index]) {
    cart[index].quantity += delta;
    if (cart[index].quantity <= 0) {
      cart.splice(index, 1);
    }
  }
  saveCartData();
  updateCartBadge();
  renderCart();
};

// Open/Close Cart Drawer
function openCart() {
  renderCart();
  document.getElementById('overlay').classList.add('active');
  document.getElementById('cartDrawer').classList.add('active');
}

function closeCart() {
  document.getElementById('overlay').classList.remove('active');
  document.getElementById('cartDrawer').classList.remove('active');
}

function closeAllModals() {
  closeCart();
  closeAddItemModal();
  closeAdminLoginModal();
  closeAboutModal();
  closeContactModal();
}

// In-App Manager: Open / Close Add Food Item Modal
function openAddItemModal() {
  editingItemId = null;
  document.getElementById('addItemForm').reset();
  document.getElementById('itemModalTitle').textContent = 'ADD NEW ITEM';
  document.getElementById('saveItemButtonText').textContent = 'SAVE DISH TO MENU';
  document.getElementById('overlay').classList.add('active');
  document.getElementById('addItemModal').classList.add('active');
}

function closeAddItemModal() {
  document.getElementById('overlay').classList.remove('active');
  document.getElementById('addItemModal').classList.remove('active');
}

// Handle Form Submission for Adding New Food Item
async function handleAddItemSubmit(e) {
  e.preventDefault();

  if (!isAdmin) {
    alert('Access Denied: Only logged in Admin can add items.');
    closeAddItemModal();
    openAdminLoginModal();
    return;
  }

  const name = document.getElementById('formItemName').value.trim();
  const category = document.getElementById('formCategory').value;
  const diet = document.getElementById('formDiet').value;
  const tag = document.getElementById('formTag').value.trim();
  const description = document.getElementById('formDesc').value.trim();
  const imageSelect = document.getElementById('formImage').value;
  const imageFile = document.getElementById('formImageFile').files[0];
  const portionType = document.getElementById('formPortionType').value;

  if (!name) {
    alert('Please enter dish name.');
    return;
  }

  const currentItem = editingItemId ? menuItems.find(item => item.id === editingItemId) : null;
  let image = imageSelect || currentItem?.image || 'assets/hero.png';
  try {
    if (imageFile) image = await uploadMenuImage(imageFile);
  } catch (error) {
    alert(`Image upload failed: ${error.message}`);
    return;
  }

  const newItem = {
    id: editingItemId || crypto.randomUUID(),
    name,
    category,
    diet,
    tag,
    description: description || 'Freshly prepared dish from NEWFORM kitchen.',
    image,
    portionType
  };

  if (portionType === 'single') {
    newItem.price = parseFloat(document.getElementById('formSinglePrice').value) || 100;
  } else {
    const qPrice = parseFloat(document.getElementById('formQPrice').value) || 100;
    const hPrice = parseFloat(document.getElementById('formHPrice').value) || 200;
    const fPrice = parseFloat(document.getElementById('formFPrice').value) || 400;
    newItem.pricesJSON = JSON.stringify({ quarter: qPrice, half: hPrice, full: fPrice });
  }

  const query = editingItemId
    ? supabase.from('menu_items').update(newItem).eq('id', editingItemId)
    : supabase.from('menu_items').insert([newItem]);
  const { data, error } = await query.select().single();

  if (error) {
    alert('Error saving item: ' + error.message);
    return;
  }
  
  if (data) {
      const savedItem = normalizeMenuItem(data);
      const existingIndex = menuItems.findIndex(item => item.id === savedItem.id);
      if (existingIndex === -1) menuItems.unshift(savedItem);
      else menuItems[existingIndex] = savedItem;
      if (savedItem.portionType === 'multi') selectedPortions[savedItem.id] = 'quarter';
  }

  renderMenu();
  closeAddItemModal();
  showToast(editingItemId ? `Updated "${name}"` : `Successfully added "${name}" to menu!`);
  editingItemId = null;
}

function normalizeMenuItem(item) {
  if (item.pricesJSON) {
    item.prices = typeof item.pricesJSON === 'string' ? JSON.parse(item.pricesJSON) : item.pricesJSON;
  }
  return item;
}

async function uploadMenuImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Images must be 5 MB or smaller.');
  const extension = file.name.split('.').pop().toLowerCase();
  const path = `${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('menu-images').upload(path, file, {
    cacheControl: '31536000',
    upsert: false,
    contentType: file.type
  });
  if (error) throw error;
  return supabase.storage.from('menu-images').getPublicUrl(path).data.publicUrl;
}

window.editItem = function(id) {
  if (!isAdmin) return openAdminLoginModal();
  const item = menuItems.find(menuItem => menuItem.id === id);
  if (!item) return;
  editingItemId = id;
  document.getElementById('itemModalTitle').textContent = 'EDIT MENU ITEM';
  document.getElementById('saveItemButtonText').textContent = 'SAVE CHANGES';
  document.getElementById('formItemName').value = item.name;
  document.getElementById('formCategory').value = item.category;
  document.getElementById('formDiet').value = item.diet;
  document.getElementById('formTag').value = item.tag || '';
  document.getElementById('formDesc').value = item.description || '';
  document.getElementById('formPortionType').value = item.portionType;
  document.getElementById('formImage').value = item.image?.startsWith('assets/') ? item.image : '';
  document.getElementById('formSinglePrice').value = item.price || '';
  document.getElementById('formQPrice').value = item.prices?.quarter || '';
  document.getElementById('formHPrice').value = item.prices?.half || '';
  document.getElementById('formFPrice').value = item.prices?.full || '';
  document.getElementById('singlePriceGroup').style.display = item.portionType === 'single' ? 'block' : 'none';
  document.getElementById('multiPriceGroup').style.display = item.portionType === 'multi' ? 'grid' : 'none';
  document.getElementById('overlay').classList.add('active');
  document.getElementById('addItemModal').classList.add('active');
};

// Delete item function (Admin Protected)
window.deleteItem = async function(id) {
  if (!isAdmin) {
    openAdminLoginModal();
    return;
  }
  if (confirm('Delete this dish from the menu?')) {
    const item = menuItems.find(menuItem => menuItem.id === id);
    const { error } = await supabase.from('menu_items').delete().eq('id', id);
    if(error) {
      alert("Failed to delete: " + error.message);
      return;
    }
    menuItems = menuItems.filter(i => i.id !== id);
    if (item?.image?.includes('/storage/v1/object/public/menu-images/')) {
      const objectPath = item.image.split('/menu-images/')[1];
      if (objectPath) await supabase.storage.from('menu-images').remove([objectPath]);
    }
    renderMenu();
    showToast('Item deleted from menu');
  }
};

// WhatsApp Direct Ordering
function processWhatsAppOrder() {
  if (cart.length === 0) {
    alert('Your cart is empty! Add dishes before sending order.');
    return;
  }

  const custName = document.getElementById('custName').value.trim() || 'Valued Customer';
  const custPhone = document.getElementById('custPhone').value.trim() || 'Not specified';
  const custAddress = document.getElementById('custAddress').value.trim() || 'Kalpetta area';

  let subtotal = 0;
  let itemsListText = '';

  cart.forEach((item, idx) => {
    const itemTotal = item.price * item.quantity;
    subtotal += itemTotal;
    itemsListText += `${idx + 1}. *${item.name}* ${item.portion ? `(${item.portion})` : ''} x ${item.quantity} = ₹${itemTotal}\n`;
  });

  const gst = Math.round(subtotal * 0.05);
  const grandTotal = subtotal + gst;

  const msg = `*NEWFORM MULTI CUISINE RESTAURANT - NEW ORDER*\n` +
              `----------------------------------------\n` +
              `*Customer Details:*\n` +
              `👤 Name: ${custName}\n` +
              `📞 Phone: ${custPhone}\n` +
              `📍 Delivery Address: ${custAddress}\n\n` +
              `*Order Summary:*\n` +
              itemsListText +
              `----------------------------------------\n` +
              `Subtotal: ₹${subtotal}\n` +
              `5% GST: ₹${gst}\n` +
              `*Grand Total: ₹${grandTotal}*\n\n` +
              `🚚 *Delivery Note:* Free home delivery within Kalpetta city limits for orders above ₹300.\n` +
              `Please confirm this order. Thank you!`;

  const encodedMsg = encodeURIComponent(msg);
  const restaurantWhatsAppNumber = '917593881112';
  const whatsappUrl = `https://wa.me/${restaurantWhatsAppNumber}?text=${encodedMsg}`;

  window.open(whatsappUrl, '_blank');
}

// Toast notification helper
function showToast(message) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#2a9d8f;"></i> ${message}`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Register PWA Service Worker
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('NEWFORM Service Worker registered'))
      .catch(err => console.log('SW reg failed', err));
  }
}
