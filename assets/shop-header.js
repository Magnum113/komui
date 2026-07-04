(function(){
  var CART_KEY = 'komui-cart-v1';
  var layer = document.getElementById('shopLayer');
  var menu = document.getElementById('shopMenuPanel');
  var search = document.getElementById('shopSearchPanel');
  var menuToggle = document.querySelector('.shop-menu-toggle');
  var searchToggle = document.querySelector('.shop-search-toggle');
  var input = document.getElementById('shopSearchInput');
  var results = document.getElementById('shopSearchResults');
  var products = Array.isArray(window.KOMUI_PRODUCTS) ? window.KOMUI_PRODUCTS : [];

  function cartItems(){
    try {
      var value = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch(e) {
      return [];
    }
  }

  function updateCartCount(){
    var count = cartItems().reduce(function(sum, item){
      return sum + (Number(item && item.qty) || 0);
    }, 0);
    document.querySelectorAll('.shop-cart-count').forEach(function(node){
      node.textContent = String(count);
      node.classList.toggle('show', count > 0);
      node.setAttribute('aria-label', count > 0 ? 'Товаров в корзине: ' + count : 'Корзина пуста');
    });
  }

  function setLocked(locked){
    document.body.classList.toggle('has-shop-layer', locked);
  }

  function closePanels(){
    if (layer) layer.hidden = true;
    if (menu) menu.hidden = true;
    if (search) search.hidden = true;
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
    if (searchToggle) searchToggle.setAttribute('aria-expanded', 'false');
    setLocked(false);
  }

  function openPanel(panel, toggle){
    closePanels();
    if (layer) layer.hidden = false;
    if (panel) panel.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    setLocked(true);
  }

  function imageOf(product){
    if (!product) return '';
    if (product.primary_image_url) return product.primary_image_url;
    if (product.main_image_path) return product.main_image_path;
    if (Array.isArray(product.image_urls) && product.image_urls[0]) return product.image_urls[0];
    return '';
  }

  function money(value){
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    return n.toLocaleString('ru-RU') + ' ₽';
  }

  function esc(value){
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function haystack(product){
    return [
      product.name, product.category, product.product_type, product.decoration_type,
      product.color_name, product.collection_name, product.anime_title, product.character_name,
      product.design_name, Array.isArray(product.tags) ? product.tags.join(' ') : ''
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function renderResults(query){
    if (!results) return;
    products = Array.isArray(window.KOMUI_PRODUCTS) ? window.KOMUI_PRODUCTS : products;
    var q = String(query || '').trim().toLowerCase();
    var list = products
      .filter(function(product){ return product && product.slug && (!q || haystack(product).indexOf(q) !== -1); })
      .slice(0, 8);
    if (!list.length) {
      results.innerHTML = '<div class="shop-search-empty">Ничего не нашли. Попробуйте запрос вроде Gojo, Naruto, худи или футболка.</div>';
      return;
    }
    results.innerHTML = list.map(function(product){
      var img = imageOf(product);
      var meta = [product.collection_name || product.anime_title, product.category, product.color_name].filter(Boolean).join(' · ');
      var price = money(product.price_min);
      return '<a class="shop-search-item" href="/p/' + esc(product.slug) + '">' +
        '<span class="shop-search-img">' + (img ? '<img src="' + esc(img) + '" alt="' + esc(product.name) + '" loading="lazy" decoding="async">' : '') + '</span>' +
        '<span class="shop-search-copy"><strong>' + esc(product.name) + '</strong>' +
        (meta ? '<small>' + esc(meta) + '</small>' : '') + '</span>' +
        (price ? '<b>' + esc(price) + '</b>' : '') +
      '</a>';
    }).join('');
  }

  if (menuToggle && menu) {
    menuToggle.addEventListener('click', function(){ openPanel(menu, menuToggle); });
  }
  if (searchToggle && search) {
    searchToggle.addEventListener('click', function(){
      openPanel(search, searchToggle);
      renderResults(input ? input.value : '');
      setTimeout(function(){ if (input) input.focus(); }, 40);
    });
  }
  if (input) input.addEventListener('input', function(){ renderResults(input.value); });
  document.addEventListener('click', function(e){
    if (e.target.closest('[data-shop-close]') || e.target === layer) closePanels();
    if (e.target.closest('.shop-menu-list a,.shop-search-item')) closePanels();
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && layer && !layer.hidden) closePanels();
  });
  window.addEventListener('storage', function(e){
    if (!e || e.key === CART_KEY) updateCartCount();
  });
  window.addEventListener('pageshow', updateCartCount);
  document.addEventListener('komui:cart-updated', updateCartCount);
  updateCartCount();
})();
