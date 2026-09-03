(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KomuiProductOffers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var STATUS = Object.freeze({
    SELECTED: 'selected',
    UNAVAILABLE: 'unavailable',
    AMBIGUOUS: 'ambiguous',
    RESELECTION_REQUIRED: 'reselection_required'
  });

  var FIT_LABELS = Object.freeze({
    regular: 'Обычная посадка',
    cropped: 'Укороченная посадка'
  });

  var WARMTH_LABELS = Object.freeze({
    fleece: 'С начёсом',
    'no-fleece': 'Без начёса'
  });

  var SIZE_ORDER = Object.freeze(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']);

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function normalizeSize(value) {
    return text(value).toUpperCase();
  }

  function sizeRank(value) {
    var index = SIZE_ORDER.indexOf(normalizeSize(value));
    return index === -1 ? SIZE_ORDER.length : index;
  }

  function offerId(offer) {
    return text(offer && (offer.offer_id != null ? offer.offer_id : offer.offerId));
  }

  function selectable(offer) {
    return !!offer && offer.archived !== true && offer.visible !== false;
  }

  function offersOf(product) {
    return Array.isArray(product && product.offers) ? product.offers.filter(Boolean) : [];
  }

  function selectableOffers(product) {
    return offersOf(product).filter(selectable);
  }

  function requiredOfferIdSizes(product) {
    var raw = product && (
      product.requires_offer_id_sizes != null
        ? product.requires_offer_id_sizes
        : product.requiresOfferIdSizes
    );
    return new Set((Array.isArray(raw) ? raw : []).map(normalizeSize).filter(Boolean));
  }

  function result(status, size, candidates, reason) {
    var list = Array.isArray(candidates) ? candidates : [];
    var offer = status === STATUS.SELECTED && list.length === 1 ? list[0] : null;
    return {
      status: status,
      reason: reason || '',
      size: normalizeSize(size),
      offer: offer,
      offerId: offer ? offerId(offer) : '',
      candidates: list
    };
  }

  function resolve(product, selection) {
    var selected = selection && typeof selection === 'object' ? selection : {};
    var size = normalizeSize(selected.size);
    var selectedOfferId = text(
      selected.offerId != null ? selected.offerId : selected.offer_id
    );
    var allOffers = offersOf(product);

    if (selectedOfferId) {
      if (!size) {
        return result(STATUS.RESELECTION_REQUIRED, size, [], 'size_required');
      }
      var exactAll = allOffers.filter(function (offer) {
        return offerId(offer) === selectedOfferId && normalizeSize(offer.size) === size;
      });
      var exactSelectable = exactAll.filter(selectable);
      if (exactSelectable.length === 1) {
        return result(STATUS.SELECTED, size, exactSelectable);
      }
      if (exactSelectable.length > 1) {
        return result(STATUS.AMBIGUOUS, size, exactSelectable, 'duplicate_offer_id');
      }
      return result(STATUS.UNAVAILABLE, size, exactAll, 'offer_unavailable');
    }

    if (!size) {
      return result(STATUS.RESELECTION_REQUIRED, size, [], 'size_required');
    }

    var candidates = selectableOffers(product).filter(function (offer) {
      return normalizeSize(offer.size) === size;
    });
    if (requiredOfferIdSizes(product).has(size)) {
      return result(STATUS.RESELECTION_REQUIRED, size, candidates, 'offer_id_required');
    }
    if (!candidates.length) {
      return result(STATUS.UNAVAILABLE, size, [], 'size_unavailable');
    }
    if (candidates.length > 1) {
      return result(STATUS.AMBIGUOUS, size, candidates, 'multiple_offers');
    }
    if (!offerId(candidates[0])) {
      return result(STATUS.RESELECTION_REQUIRED, size, candidates, 'offer_id_required');
    }
    return result(STATUS.SELECTED, size, candidates);
  }

  function sizeOptions(product) {
    var seen = new Set();
    var sizes = [];
    (Array.isArray(product && product.sizes) ? product.sizes : []).forEach(function (value) {
      var size = normalizeSize(value);
      if (size && !seen.has(size)) {
        seen.add(size);
        sizes.push(size);
      }
    });
    selectableOffers(product).forEach(function (offer) {
      var size = normalizeSize(offer.size);
      if (size && !seen.has(size)) {
        seen.add(size);
        sizes.push(size);
      }
    });
    requiredOfferIdSizes(product).forEach(function (size) {
      if (size && !seen.has(size)) {
        seen.add(size);
        sizes.push(size);
      }
    });
    sizes.sort(function (a, b) {
      return sizeRank(a) - sizeRank(b) || a.localeCompare(b, 'ru');
    });
    return sizes.map(function (size) {
      var candidates = selectableOffers(product).filter(function (offer) {
        return normalizeSize(offer.size) === size;
      });
      var status = candidates.length === 1 && offerId(candidates[0])
        ? STATUS.SELECTED
        : candidates.length > 1
          ? (requiredOfferIdSizes(product).has(size) ? STATUS.RESELECTION_REQUIRED : STATUS.AMBIGUOUS)
          : STATUS.UNAVAILABLE;
      var selected = status === STATUS.SELECTED ? candidates[0] : null;
      return {
        size: size,
        status: status,
        offer: selected,
        offerId: selected ? offerId(selected) : '',
        candidates: candidates
      };
    });
  }

  function storefrontVariant(product) {
    var raw = product && (product.storefront_variant || product.storefrontVariant) || {};
    return {
      groupKey: text(raw.groupKey != null ? raw.groupKey : raw.group_key),
      fit: text(raw.fit).toLowerCase(),
      warmth: text(raw.warmth).toLowerCase()
    };
  }

  function fitLabel(value) {
    var key = text(value).toLowerCase();
    return FIT_LABELS[key] || '';
  }

  function warmthLabel(value) {
    var key = text(value).toLowerCase();
    return WARMTH_LABELS[key] || '';
  }

  function variantLabels(product) {
    var variant = storefrontVariant(product);
    return {
      groupKey: variant.groupKey,
      fit: fitLabel(variant.fit),
      warmth: warmthLabel(variant.warmth)
    };
  }

  function hasVariantSiblings(product, products) {
    var current = storefrontVariant(product);
    if (!current.groupKey || !Array.isArray(products)) return false;
    var currentId = text(product && product.id);
    return products.some(function (candidate) {
      if (!candidate || candidate === product || !text(candidate.slug)) return false;
      var candidateId = text(candidate.id);
      if (currentId && candidateId && candidateId === currentId) return false;
      return storefrontVariant(candidate).groupKey === current.groupKey;
    });
  }

  function displayVariantLabels(product, products) {
    var labels = variantLabels(product);
    if (!hasVariantSiblings(product, products)) {
      return { groupKey: labels.groupKey, fit: '', warmth: '' };
    }
    return labels;
  }

  function cartDescription(product, size, products) {
    var labels = displayVariantLabels(product, products);
    return [labels.fit, labels.warmth, normalizeSize(size) ? 'Размер ' + normalizeSize(size) : '']
      .filter(Boolean)
      .join(' · ');
  }

  function cartKey(productId, selectedOfferId) {
    return text(productId) + ':' + text(selectedOfferId);
  }

  return Object.freeze({
    STATUS: STATUS,
    selectable: selectable,
    isSelectableOffer: selectable,
    selectableOffers: selectableOffers,
    requiredOfferIdSizes: requiredOfferIdSizes,
    normalizeSize: normalizeSize,
    offerId: offerId,
    resolve: resolve,
    resolveOffer: resolve,
    sizeOptions: sizeOptions,
    storefrontVariant: storefrontVariant,
    fitLabel: fitLabel,
    warmthLabel: warmthLabel,
    variantLabels: variantLabels,
    hasVariantSiblings: hasVariantSiblings,
    displayVariantLabels: displayVariantLabels,
    cartDescription: cartDescription,
    cartKey: cartKey
  });
});
