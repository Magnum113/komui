(function (window, document) {
  'use strict';

  var COUNTER_ID = 110916310;
  var CURRENCY = 'RUB';
  var PURCHASE_KEY_PREFIX = 'komui-metrika-purchase-v1:';
  var debug = /(?:^|[?&])(?:metrika_debug=1|_ym_debug=(?:1|2))(?:&|$)/.test(window.location.search);

  window.dataLayer = window.dataLayer || [];

  function debugLog() {
    if (!debug || !window.console) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[KOMUI analytics]');
    window.console.info.apply(window.console, args);
  }

  function finiteNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function compact(object) {
    return Object.keys(object || {}).reduce(function (result, key) {
      var value = object[key];
      if (value === undefined || value === null || value === '') return result;
      result[key] = value;
      return result;
    }, {});
  }

  function safeGoalParams(params) {
    var blocked = /^(?:email|phone|first_?name|last_?name|full_?name|address|access_?token)$/i;
    return Object.keys(params || {}).reduce(function (result, key) {
      if (blocked.test(key)) return result;
      var value = params[key];
      if (value === undefined || value === null) return result;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result[key] = value;
      }
      return result;
    }, {});
  }

  function storage(scope) {
    try {
      return scope === 'local' ? window.localStorage : window.sessionStorage;
    } catch (error) {
      return null;
    }
  }

  function markOnce(key, scope) {
    var store = storage(scope || 'session');
    if (!store) return true;
    var storageKey = 'komui-metrika-once-v1:' + key;
    try {
      if (store.getItem(storageKey)) return false;
      store.setItem(storageKey, new Date().toISOString());
      return true;
    } catch (error) {
      return true;
    }
  }

  function goal(id, params) {
    if (!id) return false;
    var payload = safeGoalParams(params);
    debugLog('goal', id, payload);
    if (typeof window.ym !== 'function') return false;
    window.ym(COUNTER_ID, 'reachGoal', id, payload);
    return true;
  }

  function goalAndWait(id, params, timeoutMs) {
    return new Promise(function (resolve) {
      if (!id || typeof window.ym !== 'function') {
        resolve(false);
        return;
      }

      var payload = safeGoalParams(params);
      var requestedTimeout = finiteNumber(timeoutMs);
      var waitMs = requestedTimeout === null ? 800 : Math.max(250, Math.min(1500, requestedTimeout));
      var settled = false;
      var timer = window.setTimeout(function () { finish(false); }, waitMs);

      function finish(sent) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(sent);
      }

      debugLog('goal-before-navigation', id, payload);
      try {
        window.ym(COUNTER_ID, 'reachGoal', id, payload, function () { finish(true); });
      } catch (error) {
        debugLog('goal-before-navigation-error', id, error && error.message);
        finish(false);
      }
    });
  }

  function goalOnce(id, key, params, scope) {
    if (!markOnce('goal:' + id + ':' + key, scope || 'session')) return false;
    return goal(id, params);
  }

  function product(raw, options) {
    raw = raw || {};
    options = options || {};
    var price = finiteNumber(options.price !== undefined ? options.price : (raw.price !== undefined ? raw.price : raw.price_min));
    var quantity = finiteNumber(options.quantity !== undefined ? options.quantity : raw.quantity);
    var position = finiteNumber(options.position !== undefined ? options.position : raw.position);
    var category = options.category || raw.category || raw.cat || raw.product_type || '';
    var collection = options.collection || raw.collection || raw.collection_name || raw.col || raw.title_name || '';
    var variant = options.variant || [options.size || raw.size, options.color || raw.color || raw.color_name]
      .filter(Boolean)
      .join(' / ');
    var categoryPath = [category, collection].filter(Boolean).join(' / ');

    return compact({
      id: String(options.id !== undefined ? options.id : (raw.id !== undefined ? raw.id : '')),
      name: options.name || raw.name || '',
      price: price,
      brand: options.brand || raw.brand || 'KOMUI',
      category: categoryPath,
      variant: variant,
      quantity: quantity && quantity > 0 ? quantity : undefined,
      list: options.list || raw.list || '',
      position: position && position > 0 ? Math.round(position) : undefined,
    });
  }

  function products(items, options) {
    options = options || {};
    return (Array.isArray(items) ? items : [])
      .map(function (item, index) {
        return product(item, Object.assign({}, options, {
          position: item && item.position ? item.position : (options.withPositions ? index + 1 : options.position),
          quantity: item && item.quantity !== undefined ? item.quantity : (item && item.qty !== undefined ? item.qty : options.quantity),
          size: item && item.size !== undefined ? item.size : options.size,
        }));
      })
      .filter(function (item) { return item.id && item.name; });
  }

  function pushEcommerce(action, payload) {
    var ecommerce = { currencyCode: CURRENCY };
    if (action === 'impressions') ecommerce.impressions = payload.products || [];
    else if (action === 'promoView' || action === 'promoClick') ecommerce[action] = { promotions: payload.promotions || [] };
    else if (action === 'purchase') ecommerce.purchase = {
      actionField: compact(payload.actionField || {}),
      products: payload.products || [],
    };
    else ecommerce[action] = { products: payload.products || [] };
    window.dataLayer.push({ ecommerce: ecommerce });
    debugLog('ecommerce', action, ecommerce[action]);
  }

  function impressions(items, list) {
    pushEcommerce('impressions', { products: products(items, { list: list, withPositions: true }) });
  }

  function productAction(action, item, options) {
    pushEcommerce(action, { products: [product(item, options)] });
  }

  function promotion(action, promo) {
    pushEcommerce(action, {
      promotions: [compact({
        id: promo.id,
        name: promo.name,
        creative: promo.creative,
        position: promo.position,
      })],
    });
  }

  function purchaseOnce(orderId, purchaseData) {
    if (!orderId) return false;
    var store = storage('local');
    var key = PURCHASE_KEY_PREFIX + String(orderId);
    try {
      if (store && store.getItem(key)) return false;
    } catch (error) {}

    purchaseData = purchaseData || {};
    var purchaseProducts = products(purchaseData.products || []);
    var revenue = finiteNumber(purchaseData.revenue);
    pushEcommerce('purchase', {
      actionField: {
        id: String(orderId),
        revenue: revenue,
        coupon: purchaseData.coupon || '',
      },
      products: purchaseProducts,
    });
    goal('order_paid', {
      order_id: String(orderId),
      order_price: revenue,
      revenue: revenue,
      currency: CURRENCY,
      items_count: purchaseProducts.reduce(function (sum, item) { return sum + (Number(item.quantity) || 1); }, 0),
      coupon: purchaseData.coupon || '',
      delivery_amount: finiteNumber(purchaseData.delivery),
    });
    try {
      if (store) store.setItem(key, new Date().toISOString());
    } catch (error) {}
    return true;
  }

  function initPromoBar() {
    var code = document.getElementById('promoCode');
    if (!code) return;
    var promo = {
      id: (code.textContent || 'KOMUI10').trim(),
      name: 'Скидка 10% на первый заказ',
      creative: 'announcement_bar',
      position: 'top',
    };
    if (markOnce('promo-view:' + promo.id + ':' + window.location.pathname, 'session')) {
      promotion('promoView', promo);
    }
    var copy = document.getElementById('promoCopy');
    if (copy) copy.addEventListener('click', function () {
      promotion('promoClick', promo);
      goal('promo_copied', { promo_code: promo.id, placement: promo.position });
    });
  }

  function initProductLinkTracking() {
    document.addEventListener('click', function (event) {
      var link = event.target && event.target.closest ? event.target.closest('[data-metrika-product-id]') : null;
      if (!link) return;
      var id = String(link.getAttribute('data-metrika-product-id') || '');
      var source = Array.isArray(window.KOMUI_PRODUCTS) ? window.KOMUI_PRODUCTS : [];
      var item = source.find(function (candidate) { return String(candidate && candidate.id) === id; });
      if (!item) return;
      productAction('click', item, { list: link.getAttribute('data-metrika-list') || 'recommendations' });
    });
  }

  window.KomuiAnalytics = {
    counterId: COUNTER_ID,
    currency: CURRENCY,
    goal: goal,
    goalAndWait: goalAndWait,
    goalOnce: goalOnce,
    markOnce: markOnce,
    product: product,
    products: products,
    ecommerce: {
      impressions: impressions,
      click: function (item, options) { productAction('click', item, options); },
      detail: function (item, options) { productAction('detail', item, options); },
      add: function (item, options) { productAction('add', item, options); },
      remove: function (item, options) { productAction('remove', item, options); },
      promoView: function (promo) { promotion('promoView', promo); },
      promoClick: function (promo) { promotion('promoClick', promo); },
      purchaseOnce: purchaseOnce,
    },
  };
  try { document.dispatchEvent(new CustomEvent('komui:analytics-ready')); } catch (error) {}

  initProductLinkTracking();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPromoBar, { once: true });
  else initPromoBar();
})(window, document);
