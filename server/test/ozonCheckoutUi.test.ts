import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";

function page(fetch: (...args: any[]) => Promise<any> = async () => { throw new Error("Unexpected request"); }) {
  const html = readFileSync(fileURLToPath(new URL("../../checkout.html", import.meta.url)), "utf8");
  const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes("const CART_KEY="))!;
  const nodes = new Map<string, any>();
  const node = (key: string) => {
    if (!nodes.has(key)) nodes.set(key, { value: "", textContent: "", innerHTML: "", hidden: false, disabled: false, style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, addEventListener() {}, focus() {}, scrollIntoView() {} });
    return nodes.get(key);
  };
  const storage = new Map<string, string>();
  const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const window: any = { KOMUI_PRODUCTS: [], KomuiProductOffers: {}, KOMUI_DELIVERY: { providers: [{ id: "cdek", enabled: true }, { id: "ozon", enabled: true }] } };
  const context = vm.createContext({ window, document: { querySelector: node, querySelectorAll: () => [], addEventListener() {} }, localStorage: store, sessionStorage: store, location: { search: "", protocol: "https:" }, URLSearchParams, fetch, crypto: { randomUUID: () => "a" }, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }), console });
  vm.runInContext(source.replace("init();\n})();", "window.checkoutTest = { run: (source) => eval(source) };\n})();"), context);
  return { run: (source: string) => window.checkoutTest.run(source), node, storage };
}

test("changing carrier clears selected quote, point cache and payment identity", () => {
  const p = page();
  p.run("selectedPoint={code:'CDEK-1',price:350}; points=[selectedPoint]; pointsLoaded=true; sessionStorage.setItem(PAYMENT_DRAFT_KEY,'old'); changeDeliveryProvider('ozon')");
  assert.equal(p.run("deliveryProvider"), "ozon");
  assert.equal(p.run("selectedPoint"), null);
  assert.equal(p.run("points.length"), 0);
  assert.equal(p.run("sessionStorage.getItem(PAYMENT_DRAFT_KEY)"), null);
});

test("selected Ozon point uses safe display text while preserving its original address", () => {
  const p = page();
  p.run(`selectedPoint={code:'445692',city:'Махачкала',address:'Россия, Республика, Махачкала, улица, 1',displayAddress:'Махачкала, улица, 1',hours:'Ежедневно, 09:00–21:00',hoursDetails:'28 сент. – 18 окт.: 09:00–21:00 <test>',days:'6 дн.',price:123}; renderSelectedPoint()`);
  const html = p.node("#selectedPoint").innerHTML;
  assert.ok(html.includes('<h3>Махачкала, улица, 1</h3>'));
  assert.ok(html.includes('График по датам'));
  assert.ok(html.includes('&lt;test&gt;'));
  assert.ok(!html.includes('<test>'));
  assert.equal(p.run("selectedPoint.address"), 'Россия, Республика, Махачкала, улица, 1');
});

test("Ozon cannot be selected when not enabled by server configuration", () => {
  const p = page();
  p.run("window.KOMUI_DELIVERY.providers=[]; changeDeliveryProvider('ozon')");
  assert.equal(p.run("deliveryProvider"), "cdek");
});

test("outdated point response cannot overwrite newer carrier selection", async () => {
  let finish!: (response: any) => void;
  const p = page(() => new Promise(resolve => { finish = resolve; }));
  p.node("#citySearch").value = "Москва";
  const pending = p.run("loadDeliveryPoints()");
  p.run("changeDeliveryProvider('ozon')");
  finish({ ok: true, json: async () => ({ city: { name: "Москва" }, points: [{ code: "CDEK-STALE" }] }) });
  await pending;
  assert.equal(p.run("points.length"), 0);
  assert.equal(p.run("selectedPoint"), null);
});

test("Ozon quote passes customer phone and preserves kopecks", async () => {
  let request: any;
  const p = page(async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ amount: 32145, eta: "3 дня" }) }; });
  p.node("#phone").value = "+7 (999) 123-45-67";
  const quote = await p.run("deliveryProvider='ozon'; pendingPoint={code:'123',cityCode:null}; quotePendingPoint()");
  assert.equal(request.delivery.provider, "ozon");
  assert.equal(request.customer.phone, "+7 (999) 123-45-67");
  assert.equal(quote.price, 321.45);
  assert.equal(quote.provider, "ozon");
});

test("quote is discarded if recipient changes while request is in flight", async () => {
  let finish!: (response: any) => void;
  const p = page(() => new Promise(resolve => { finish = resolve; }));
  const pending = p.run("deliveryProvider='ozon'; pendingPoint={code:'123'}; choosePendingPoint()");
  p.run("resetDeliveryQuote()");
  finish({ ok: true, json: async () => ({ amount: 30000 }) });
  await pending;
  assert.equal(p.run("selectedPoint"), null);
});

test("restoring a different cart invalidates the saved delivery price", () => {
  const p = page();
  p.run("sessionStorage.setItem(FORM_KEY,JSON.stringify({point:{code:'C',cityCode:44,price:350},cartFingerprint:'different'})); restoreForm()");
  assert.equal(p.run("selectedPoint"), null);
});

 test("Ozon address search requests matching points beyond the initial city page", async () => {
  let body: any;
  const p=page(async (_url, options) => { body=JSON.parse(options.body); return {ok:true,json:async()=>({city:{name:"Москва"},points:[{code:"BEYOND-120",address:"Новый адрес"}]})}; });
  p.node("#citySearch").value="Москва";
  p.node("#pointSearch").value="Новый адрес";
  p.run("deliveryProvider='ozon'; points=[{code:'INITIAL'}]; pendingPoint=points[0]; searchDeliveryPoints(); clearTimeout(pointLoadTimer)");
  assert.equal(p.run("pendingPoint"),null);
  await p.run("loadDeliveryPoints()");
  assert.equal(body.query,"Новый адрес");
  assert.equal(body.provider,"ozon");
  assert.equal(p.run("points[0].code"),"BEYOND-120");
});
