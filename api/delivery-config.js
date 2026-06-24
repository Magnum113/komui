module.exports = function deliveryConfig(_request, response) {
  const yandexMapsApiKey =
    process.env.yandexMapsApiKey ||
    process.env.YANDEX_MAPS_API_KEY ||
    process.env.NEXT_PUBLIC_YANDEX_MAPS_API_KEY ||
    "";

  response.setHeader("Content-Type", "application/javascript; charset=utf-8");
  response.setHeader("Cache-Control", yandexMapsApiKey ? "public, max-age=300, s-maxage=300" : "no-store");
  response.status(200).send(
    `window.KOMUI_DELIVERY = Object.assign({}, window.KOMUI_DELIVERY, { yandexMapsApiKey: ${JSON.stringify(yandexMapsApiKey)} });`
  );
};
