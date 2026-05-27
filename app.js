const DB_NAME = "laminas-mundial-pos-db";
const DB_VERSION = 1;
const STORE_NAMES = ["products", "suppliers", "sales", "purchases", "payments", "settings"];
const DEFAULT_PRODUCT_ID = "product-laminas-mundial";
const DEFAULT_SUPPLIER_ID = "supplier-general";
const ADMIN_PIN = "4818";

let db;
let pendingDelete = null;
let pendingEdit = null;
let toastTimer;

const state = {
  products: [],
  suppliers: [],
  sales: [],
  purchases: [],
  payments: [],
  settings: {
    salePricePresets: [500, 700, 1000, 1500],
    lastSalePrice: 1000
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const nextDb = request.result;
      for (const name of STORE_NAMES) {
        if (!nextDb.objectStoreNames.contains(name)) {
          nextDb.createObjectStore(name, { keyPath: "id" });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function store(name, mode = "readonly") {
  return db.transaction(name, mode).objectStore(name);
}

function getAll(name) {
  return new Promise((resolve, reject) => {
    const request = store(name).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function put(name, value) {
  return new Promise((resolve, reject) => {
    const request = store(name, "readwrite").put(value);
    request.onsuccess = () => resolve(value);
    request.onerror = () => reject(request.error);
  });
}

function deleteById(name, id) {
  return new Promise((resolve, reject) => {
    const request = store(name, "readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearStore(name) {
  return new Promise((resolve, reject) => {
    const request = store(name, "readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function money(value) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0
  }).format(Math.round(Number(value) || 0));
}

function units(value, label = "lámina") {
  const n = Number(value) || 0;
  const text = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(n);
  return `${text} ${n === 1 ? label : `${label}s`}`;
}

function todayInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function inputDateToIso(value) {
  const now = new Date();
  if (!value) return now.toISOString();
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()).toISOString();
}

function dateTime(value) {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function shortDate(value) {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "short" }).format(new Date(value));
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date) {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

function nextMonth(date) {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

function isInRange(iso, start, end) {
  const time = new Date(iso).getTime();
  return time >= start.getTime() && time < end.getTime();
}

function monthKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [year, month] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("es-CL", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function monthRange(key) {
  const [year, month] = key.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  return { start, end: nextMonth(start) };
}

function addMonths(date, amount) {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + amount);
  return d;
}

function percent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function productName(id) {
  return state.products.find((product) => product.id === id)?.name || "Producto eliminado";
}

function supplierName(id) {
  return state.suppliers.find((supplier) => supplier.id === id)?.name || "Proveedor eliminado";
}

function activeProducts() {
  return state.products.filter((product) => product.active !== false).sort((a, b) => a.name.localeCompare(b.name));
}

function activeSuppliers() {
  return state.suppliers.filter((supplier) => supplier.active !== false).sort((a, b) => a.name.localeCompare(b.name));
}

function saleTotal(sale) {
  return (Number(sale.quantity) || 0) * (Number(sale.unitPrice) || 0);
}

function purchaseTotal(purchase) {
  return (Number(purchase.quantity) || 0) * (Number(purchase.unitCost) || 0);
}

function purchasePaid(purchase) {
  const directPaid = Number(purchase.initialPaid) || 0;
  const payments = state.payments
    .filter((payment) => payment.supplierId === purchase.supplierId)
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  const supplierPurchases = state.purchases
    .filter((row) => row.supplierId === purchase.supplierId && row.debtStatus === "debe")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let remainingPayments = payments;
  for (const row of supplierPurchases) {
    const rowDebt = Math.max(0, purchaseTotal(row) - (Number(row.initialPaid) || 0));
    const applied = Math.min(rowDebt, remainingPayments);
    remainingPayments -= applied;
    if (row.id === purchase.id) return directPaid + applied;
  }
  return directPaid;
}

function supplierDebt(supplierId) {
  const debt = state.purchases
    .filter((purchase) => purchase.supplierId === supplierId && purchase.debtStatus === "debe")
    .reduce((sum, purchase) => sum + Math.max(0, purchaseTotal(purchase) - (Number(purchase.initialPaid) || 0)), 0);
  const paid = state.payments
    .filter((payment) => payment.supplierId === supplierId)
    .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
  return debt - paid;
}

function stockByProduct() {
  const stock = new Map();
  for (const product of activeProducts()) {
    stock.set(product.id, { product, bought: 0, sold: 0, stock: 0, avgCost: 0, costTotal: 0 });
  }
  for (const purchase of state.purchases) {
    if (!stock.has(purchase.productId)) {
      stock.set(purchase.productId, { product: { id: purchase.productId, name: productName(purchase.productId) }, bought: 0, sold: 0, stock: 0, avgCost: 0, costTotal: 0 });
    }
    const row = stock.get(purchase.productId);
    const qty = Number(purchase.quantity) || 0;
    const total = purchaseTotal(purchase);
    row.bought += qty;
    row.costTotal += total;
  }
  for (const sale of state.sales) {
    if (!stock.has(sale.productId)) {
      stock.set(sale.productId, { product: { id: sale.productId, name: productName(sale.productId) }, bought: 0, sold: 0, stock: 0, avgCost: 0, costTotal: 0 });
    }
    stock.get(sale.productId).sold += Number(sale.quantity) || 0;
  }
  for (const row of stock.values()) {
    row.stock = row.bought - row.sold;
    row.avgCost = row.bought > 0 ? row.costTotal / row.bought : 0;
  }
  return Array.from(stock.values()).sort((a, b) => a.product.name.localeCompare(b.product.name));
}

function totalStock() {
  return stockByProduct().reduce((sum, row) => sum + row.stock, 0);
}

async function loadState() {
  const [products, suppliers, sales, purchases, payments, settingsRows] = await Promise.all([
    getAll("products"),
    getAll("suppliers"),
    getAll("sales"),
    getAll("purchases"),
    getAll("payments"),
    getAll("settings")
  ]);

  if (!products.length) {
    const defaultProduct = {
      id: DEFAULT_PRODUCT_ID,
      name: "Láminas Mundial",
      active: true,
      createdAt: new Date().toISOString()
    };
    await put("products", defaultProduct);
    products.push(defaultProduct);
  }

  if (!suppliers.length) {
    const defaultSupplier = {
      id: DEFAULT_SUPPLIER_ID,
      name: "Proveedor general",
      active: true,
      createdAt: new Date().toISOString()
    };
    await put("suppliers", defaultSupplier);
    suppliers.push(defaultSupplier);
  }

  state.products = products;
  state.suppliers = suppliers;
  state.sales = sales.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.purchases = purchases.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.payments = payments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.settings = { ...state.settings, ...(settingsRows.find((row) => row.id === "main") || {}) };
}

async function saveSettings() {
  await put("settings", { id: "main", ...state.settings });
}

function fillSelect(select, rows, getLabel) {
  select.innerHTML = rows.map((row) => `<option value="${row.id}">${getLabel(row)}</option>`).join("");
}

function setDefaultDates() {
  const today = todayInputValue();
  for (const input of ["#saleDate", "#purchaseDate", "#paymentDate"]) {
    const element = $(input);
    if (element && !element.value) element.value = today;
  }
}

function updateClock() {
  const element = $("#saleClock");
  if (!element) return;
  element.textContent = new Intl.DateTimeFormat("es-CL", { timeStyle: "short" }).format(new Date());
}

function renderPriceButtons() {
  const wrap = $("#salePriceButtons");
  const current = Number($("#salePrice").value) || 0;
  wrap.innerHTML = state.settings.salePricePresets
    .slice()
    .sort((a, b) => a - b)
    .map((price) => `<button class="price-chip ${price === current ? "active" : ""}" type="button" data-price="${price}">${money(price)}</button>`)
    .join("");
  wrap.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      $("#salePrice").value = button.dataset.price;
      state.settings.lastSalePrice = Number(button.dataset.price);
      saveSettings();
      updateSalePreview();
      renderPriceButtons();
    });
  });
}

function renderSelectors() {
  const products = activeProducts();
  const suppliers = activeSuppliers();
  fillSelect($("#saleProduct"), products, (product) => product.name);
  fillSelect($("#purchaseProduct"), products, (product) => product.name);
  fillSelect($("#purchaseSupplier"), suppliers, (supplier) => supplier.name);
  fillSelect($("#paymentSupplier"), suppliers.map((supplier) => ({ ...supplier, debt: supplierDebt(supplier.id) })), (supplier) => {
    const debt = supplier.debt;
    return `${supplier.name} · ${debt < 0 ? "saldo a favor " : "deuda "}${money(Math.abs(debt))}`;
  });
  if (!$("#salePrice").value) $("#salePrice").value = state.settings.lastSalePrice || state.settings.salePricePresets[0] || 1000;
  renderPriceButtons();
}

function updateSalePreview() {
  const qty = Number($("#saleQty").value) || 0;
  const price = Number($("#salePrice").value) || 0;
  $("#salePreview").textContent = money(qty * price);
}

function updatePurchasePreview() {
  const qty = Number($("#purchaseQty").value) || 0;
  const cost = Number($("#purchaseCost").value) || 0;
  const paid = Number($("#purchasePaid").value) || 0;
  const status = document.querySelector("input[name='purchaseDebtStatus']:checked")?.value || "pagado";
  const debt = status === "debe" ? Math.max(0, qty * cost - paid) : 0;
  $("#purchaseDebtPreview").textContent = money(debt);
}

function renderList(container, rows, emptyMessage) {
  container.innerHTML = rows.length ? rows.join("") : `<div class="empty">${emptyMessage}</div>`;
}

function renderSummary() {
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todaySales = state.sales.filter((sale) => isInRange(sale.createdAt, todayStart, tomorrow));
  const todayTotal = todaySales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const todayUnits = todaySales.reduce((sum, sale) => sum + (Number(sale.quantity) || 0), 0);
  const receivable = state.sales.filter((sale) => sale.paymentStatus === "pendiente").reduce((sum, sale) => sum + saleTotal(sale), 0);
  const stock = totalStock();
  $("#topTodaySales").textContent = money(todayTotal);
  $("#topTodayUnits").textContent = `${units(todayUnits)} vendidas`;
  $("#topStock").textContent = units(stock);
  $("#topReceivable").textContent = money(receivable);
}

function saleMeta(sale) {
  const status = sale.paymentStatus === "pendiente" ? "pendiente" : sale.paymentStatus;
  const note = sale.note ? ` · ${sale.note}` : "";
  return `${dateTime(sale.createdAt)} · ${productName(sale.productId)} · ${units(sale.quantity)} · ${status}${note}`;
}

function purchaseMeta(purchase) {
  const debt = purchase.debtStatus === "debe" ? Math.max(0, purchaseTotal(purchase) - (Number(purchase.initialPaid) || 0)) : 0;
  const debtText = debt > 0 ? ` · debe ${money(debt)}` : " · pagado";
  const person = purchase.debtPerson ? ` · ${purchase.debtPerson}` : "";
  return `${shortDate(purchase.createdAt)} · ${productName(purchase.productId)} · ${units(purchase.quantity)} · ${supplierName(purchase.supplierId)}${debtText}${person}`;
}

function renderRecent() {
  renderList(
    $("#recentSales"),
    state.sales.slice(0, 6).map((sale) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${money(saleTotal(sale))}</span>
          <span class="item-meta">${saleMeta(sale)}</span>
        </div>
      </article>
    `),
    "Aún no hay ventas."
  );

  const openPurchases = activeSuppliers()
    .map((supplier) => ({ supplier, debt: supplierDebt(supplier.id) }))
    .filter((row) => row.debt > 0);
  renderList(
    $("#openPurchases"),
    openPurchases.map((row) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${row.supplier.name}</span>
          <span class="item-meta">Pendiente ${money(row.debt)}</span>
        </div>
      </article>
    `),
    "No hay compras pendientes."
  );

  renderList(
    $("#supplierDebts"),
    activeSuppliers().map((supplier) => {
      const debt = supplierDebt(supplier.id);
      return `
        <article class="list-item">
          <div class="list-main">
            <span class="list-title">${supplier.name}</span>
            <span class="item-meta">${debt >= 0 ? "Deuda" : "Saldo a favor"} ${money(Math.abs(debt))}</span>
          </div>
        </article>
      `;
    }),
    "No hay proveedores."
  );
}

function renderInventory() {
  const rows = stockByProduct();
  const html = rows.map((row) => `
    <article class="list-item">
      <div class="list-main">
        <span class="list-title">${row.product.name}</span>
        <span class="item-meta">Compradas ${units(row.bought)} · Vendidas ${units(row.sold)} · Costo prom. ${money(row.avgCost)}</span>
      </div>
      <strong>${units(row.stock)}</strong>
    </article>
  `);
  renderList($("#inventoryList"), html, "Aún no hay inventario.");
}

function allMonthKeys() {
  const keys = new Set([monthKey(new Date())]);
  for (const row of [...state.sales, ...state.purchases, ...state.payments]) keys.add(monthKey(row.createdAt));
  return Array.from(keys).sort().reverse();
}

function renderDashboard() {
  const select = $("#dashboardMonth");
  const current = select.value || monthKey(new Date());
  const keys = allMonthKeys();
  select.innerHTML = keys.map((key) => `<option value="${key}">${monthLabel(key)}</option>`).join("");
  select.value = keys.includes(current) ? current : keys[0];
  const { start, end } = monthRange(select.value);
  const sales = state.sales.filter((sale) => isInRange(sale.createdAt, start, end));
  const purchases = state.purchases.filter((purchase) => isInRange(purchase.createdAt, start, end));
  const salesTotal = sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const purchasesTotal = purchases.reduce((sum, purchase) => sum + purchaseTotal(purchase), 0);
  const sold = sales.reduce((sum, sale) => sum + (Number(sale.quantity) || 0), 0);
  const bought = purchases.reduce((sum, purchase) => sum + (Number(purchase.quantity) || 0), 0);
  const cash = sales.filter((sale) => sale.paymentStatus === "efectivo").reduce((sum, sale) => sum + saleTotal(sale), 0);
  const card = sales.filter((sale) => sale.paymentStatus === "tarjeta").reduce((sum, sale) => sum + saleTotal(sale), 0);
  const pending = sales.filter((sale) => sale.paymentStatus === "pendiente").reduce((sum, sale) => sum + saleTotal(sale), 0);
  const pendingRows = sales.filter((sale) => sale.paymentStatus === "pendiente");
  const providerDebt = activeSuppliers().reduce((sum, supplier) => sum + Math.max(0, supplierDebt(supplier.id)), 0);
  const stockRows = stockByProduct();
  const stockTotal = stockRows.reduce((sum, row) => sum + row.stock, 0);
  const lowStock = stockRows.filter((row) => row.stock <= 10);
  const avgCostByProduct = new Map(stockRows.map((row) => [row.product.id, row.avgCost || 0]));
  const estimatedCostOfSold = sales.reduce((sum, sale) => {
    return sum + ((Number(sale.quantity) || 0) * (avgCostByProduct.get(sale.productId) || 0));
  }, 0);
  const grossProfit = salesTotal - estimatedCostOfSold;
  const margin = salesTotal > 0 ? (grossProfit / salesTotal) * 100 : 0;
  const paymentTotal = cash + card + pending;
  const setBar = (selector, value) => {
    const width = paymentTotal > 0 ? clamp((value / paymentTotal) * 100, 3, 100) : 0;
    $(selector).style.width = `${width}%`;
  };

  $("#monthSales").textContent = money(salesTotal);
  $("#monthGrossProfit").textContent = money(grossProfit);
  $("#monthMargin").textContent = `${percent(margin)} margen`;
  $("#monthCashFlow").textContent = money(salesTotal - purchasesTotal);
  $("#monthPurchases").textContent = money(purchasesTotal);
  $("#monthBought").textContent = units(bought);
  $("#monthSold").textContent = `${units(sold)} vendidas`;
  $("#monthAverage").textContent = money(sales.length ? salesTotal / sales.length : 0);
  $("#dashboardStockTotal").textContent = units(stockTotal);
  $("#lowStockCount").textContent = `${lowStock.length} productos`;
  $("#monthCash").textContent = money(cash);
  $("#monthCard").textContent = money(card);
  $("#monthPending").textContent = money(pending);
  $("#monthPendingBarValue").textContent = money(pending);
  $("#pendingCount").textContent = `${pendingRows.length} ${pendingRows.length === 1 ? "venta pendiente" : "ventas pendientes"}`;
  $("#providerDebtTotal").textContent = money(providerDebt);
  setBar("#cashBar", cash);
  setBar("#cardBar", card);
  setBar("#pendingBar", pending);

  renderMonthlyTrend(select.value);
  renderTopProducts(sales, avgCostByProduct);
  renderBusinessAlerts({ pendingRows, lowStock, providerDebt, grossProfit, salesTotal, stockTotal });
}

function renderMonthlyTrend(selectedKey) {
  const { start } = monthRange(selectedKey);
  const months = Array.from({ length: 6 }, (_, index) => monthKey(addMonths(start, index - 5)));
  const values = months.map((key) => {
    const range = monthRange(key);
    const total = state.sales
      .filter((sale) => isInRange(sale.createdAt, range.start, range.end))
      .reduce((sum, sale) => sum + saleTotal(sale), 0);
    return { key, total };
  });
  const max = Math.max(...values.map((row) => row.total), 1);
  $("#monthlyTrendChart").innerHTML = values.map((row) => {
    const height = row.total > 0 ? clamp((row.total / max) * 100, 8, 100) : 4;
    const month = monthLabel(row.key).slice(0, 3);
    const active = row.key === selectedKey ? "active" : "";
    return `
      <div class="bar-column ${active}">
        <span>${money(row.total)}</span>
        <i style="height:${height}%"></i>
        <small>${month}</small>
      </div>
    `;
  }).join("");
}

function renderTopProducts(sales, avgCostByProduct) {
  const byProduct = new Map();
  for (const sale of sales) {
    const row = byProduct.get(sale.productId) || { productId: sale.productId, quantity: 0, revenue: 0, profit: 0 };
    const qty = Number(sale.quantity) || 0;
    row.quantity += qty;
    row.revenue += saleTotal(sale);
    row.profit += saleTotal(sale) - (qty * (avgCostByProduct.get(sale.productId) || 0));
    byProduct.set(sale.productId, row);
  }
  const rows = Array.from(byProduct.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);
  renderList(
    $("#topProductsList"),
    rows.map((row) => `
      <article class="list-item product-rank">
        <div class="list-main">
          <span class="list-title">${escapeHtml(productName(row.productId))}</span>
          <span class="item-meta">${units(row.quantity)} · Ganancia estimada ${money(row.profit)}</span>
        </div>
        <strong>${money(row.revenue)}</strong>
      </article>
    `),
    "Aún no hay ventas en este mes."
  );
}

function renderBusinessAlerts({ pendingRows, lowStock, providerDebt, grossProfit, salesTotal, stockTotal }) {
  const alerts = [];
  if (pendingRows.length) {
    const total = pendingRows.reduce((sum, sale) => sum + saleTotal(sale), 0);
    alerts.push({
      title: "Cobros pendientes",
      meta: `${pendingRows.length} ventas por cobrar · ${money(total)}`
    });
  }
  if (lowStock.length) {
    alerts.push({
      title: "Stock bajo",
      meta: lowStock.slice(0, 4).map((row) => `${row.product.name}: ${units(row.stock)}`).join(" · ")
    });
  }
  if (providerDebt > 0) {
    alerts.push({
      title: "Deuda con proveedores",
      meta: `Total pendiente ${money(providerDebt)}`
    });
  }
  if (salesTotal > 0 && grossProfit < 0) {
    alerts.push({
      title: "Margen negativo",
      meta: "El costo estimado supera las ventas del mes."
    });
  }
  if (stockTotal <= 10) {
    alerts.push({
      title: "Inventario muy ajustado",
      meta: `Quedan ${units(stockTotal)} en total.`
    });
  }
  renderList(
    $("#businessAlerts"),
    alerts.map((alert) => `
      <article class="list-item alert-item">
        <div class="list-main">
          <span class="list-title">${escapeHtml(alert.title)}</span>
          <span class="item-meta">${escapeHtml(alert.meta)}</span>
        </div>
      </article>
    `),
    "Sin alertas críticas para este mes."
  );
}

function historyActions(type, id) {
  return `
    <div class="item-actions">
      <button class="action-button" data-edit="${type}" data-id="${id}" title="Modificar">✎</button>
      <button class="action-button delete" data-delete="${type}" data-id="${id}" title="Eliminar">×</button>
    </div>
  `;
}

function renderHistory() {
  const filter = $("#historyFilter").value;
  let rows = [];
  if (filter === "sales") {
    rows = state.sales.map((sale) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${money(saleTotal(sale))}</span>
          <span class="item-meta">${saleMeta(sale)}</span>
        </div>
        ${historyActions("sales", sale.id)}
      </article>
    `);
  }
  if (filter === "purchases") {
    rows = state.purchases.map((purchase) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${money(purchaseTotal(purchase))}</span>
          <span class="item-meta">${purchaseMeta(purchase)}</span>
        </div>
        ${historyActions("purchases", purchase.id)}
      </article>
    `);
  }
  if (filter === "payments") {
    rows = state.payments.map((payment) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${money(payment.amount)}</span>
          <span class="item-meta">${shortDate(payment.createdAt)} · ${supplierName(payment.supplierId)}${payment.note ? ` · ${payment.note}` : ""}</span>
        </div>
        ${historyActions("payments", payment.id)}
      </article>
    `);
  }
  if (filter === "debtors") {
    rows = state.sales.filter((sale) => sale.paymentStatus === "pendiente").map((sale) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${sale.note || "Cliente sin nombre"}</span>
          <span class="item-meta">${money(saleTotal(sale))} · ${dateTime(sale.createdAt)} · ${productName(sale.productId)}</span>
        </div>
        ${historyActions("sales", sale.id)}
      </article>
    `);
  }
  if (filter === "suppliers") {
    rows = activeSuppliers().map((supplier) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${supplier.name}</span>
          <span class="item-meta">${supplierDebt(supplier.id) >= 0 ? "Deuda" : "Saldo a favor"} ${money(Math.abs(supplierDebt(supplier.id)))}</span>
        </div>
        ${historyActions("suppliers", supplier.id)}
      </article>
    `);
  }
  renderList($("#historyList"), rows, "No hay registros para mostrar.");
  $("#historyList").querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openEdit(button.dataset.edit, button.dataset.id));
  });
  $("#historyList").querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => requestDelete(button.dataset.delete, button.dataset.id));
  });
}

function renderAll() {
  setDefaultDates();
  renderSelectors();
  renderSummary();
  renderRecent();
  renderInventory();
  renderDashboard();
  renderHistory();
  updateSalePreview();
  updatePurchasePreview();
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2200);
}

function activeRadioValue(name) {
  return document.querySelector(`input[name='${name}']:checked`)?.value;
}

async function addProduct(name) {
  const clean = name.trim();
  if (!clean) return null;
  const existing = activeProducts().find((product) => product.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const product = { id: uid("product"), name: clean, active: true, createdAt: new Date().toISOString() };
  await put("products", product);
  await loadState();
  return product;
}

async function addSupplier(name) {
  const clean = name.trim();
  if (!clean) return null;
  const existing = activeSuppliers().find((supplier) => supplier.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const supplier = { id: uid("supplier"), name: clean, active: true, createdAt: new Date().toISOString() };
  await put("suppliers", supplier);
  await loadState();
  return supplier;
}

function editField(label, id, type, value, attrs = "") {
  return `<label>${label}<input id="${id}" type="${type}" value="${String(value ?? "").replaceAll('"', "&quot;")}" ${attrs}></label>`;
}

function editSelect(label, id, rows, value, getLabel) {
  return `<label>${label}<select id="${id}">${rows.map((row) => `<option value="${row.id}" ${row.id === value ? "selected" : ""}>${getLabel(row)}</option>`).join("")}</select></label>`;
}

function openEdit(type, id) {
  pendingEdit = { type, id };
  const fields = $("#editFields");
  const title = $("#editTitle");
  if (type === "sales") {
    const sale = state.sales.find((row) => row.id === id);
    title.textContent = "Modificar venta";
    fields.innerHTML = [
      editSelect("Producto", "editProductId", activeProducts(), sale.productId, (row) => row.name),
      editField("Fecha", "editDate", "date", todayInputValueFromIso(sale.createdAt), "required"),
      editField("Cantidad", "editQuantity", "number", sale.quantity, "min='1' step='1' required"),
      editField("Precio unitario", "editUnitPrice", "number", sale.unitPrice, "min='0' step='1' required"),
      `<label>Estado pago<select id="editPaymentStatus">
        <option value="efectivo" ${sale.paymentStatus === "efectivo" ? "selected" : ""}>Efectivo</option>
        <option value="tarjeta" ${sale.paymentStatus === "tarjeta" ? "selected" : ""}>Tarjeta</option>
        <option value="pendiente" ${sale.paymentStatus === "pendiente" ? "selected" : ""}>Pendiente</option>
      </select></label>`,
      editField("Cliente / nota", "editNote", "text", sale.note || "")
    ].join("");
  }
  if (type === "purchases") {
    const purchase = state.purchases.find((row) => row.id === id);
    title.textContent = "Modificar compra";
    fields.innerHTML = [
      editSelect("Producto", "editProductId", activeProducts(), purchase.productId, (row) => row.name),
      editSelect("Proveedor", "editSupplierId", activeSuppliers(), purchase.supplierId, (row) => row.name),
      editField("Fecha", "editDate", "date", todayInputValueFromIso(purchase.createdAt), "required"),
      editField("Cantidad", "editQuantity", "number", purchase.quantity, "min='1' step='1' required"),
      editField("Costo unitario", "editUnitCost", "number", purchase.unitCost, "min='0' step='1' required"),
      `<label>Estado compra<select id="editDebtStatus">
        <option value="pagado" ${purchase.debtStatus === "pagado" ? "selected" : ""}>Pagado</option>
        <option value="debe" ${purchase.debtStatus === "debe" ? "selected" : ""}>Se debe</option>
      </select></label>`,
      editField("Persona a quien se debe", "editDebtPerson", "text", purchase.debtPerson || ""),
      editField("Abono inicial", "editInitialPaid", "number", purchase.initialPaid || 0, "min='0' step='1'"),
      editField("Nota", "editNote", "text", purchase.note || "")
    ].join("");
  }
  if (type === "payments") {
    const payment = state.payments.find((row) => row.id === id);
    title.textContent = "Modificar pago";
    fields.innerHTML = [
      editSelect("Proveedor", "editSupplierId", activeSuppliers(), payment.supplierId, (row) => row.name),
      editField("Fecha", "editDate", "date", todayInputValueFromIso(payment.createdAt), "required"),
      editField("Monto", "editAmount", "number", payment.amount, "min='1' step='1' required"),
      editField("Nota", "editNote", "text", payment.note || "")
    ].join("");
  }
  if (type === "suppliers") {
    const supplier = state.suppliers.find((row) => row.id === id);
    title.textContent = "Modificar proveedor";
    fields.innerHTML = editField("Nombre", "editName", "text", supplier.name, "required");
  }
  $("#editDialog").showModal();
}

function todayInputValueFromIso(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateKeepingTime(originalIso, dateValue) {
  const original = new Date(originalIso);
  const [year, month, day] = dateValue.split("-").map(Number);
  return new Date(year, month - 1, day, original.getHours(), original.getMinutes(), original.getSeconds(), original.getMilliseconds()).toISOString();
}

async function saveEdit(event) {
  event.preventDefault();
  const { type, id } = pendingEdit || {};
  if (!type || !id) return;
  if (type === "sales") {
    const sale = state.sales.find((row) => row.id === id);
    await put("sales", {
      ...sale,
      productId: $("#editProductId").value,
      createdAt: dateKeepingTime(sale.createdAt, $("#editDate").value),
      quantity: Number($("#editQuantity").value),
      unitPrice: Number($("#editUnitPrice").value),
      paymentStatus: $("#editPaymentStatus").value,
      note: $("#editNote").value.trim(),
      updatedAt: new Date().toISOString()
    });
  }
  if (type === "purchases") {
    const purchase = state.purchases.find((row) => row.id === id);
    await put("purchases", {
      ...purchase,
      productId: $("#editProductId").value,
      supplierId: $("#editSupplierId").value,
      createdAt: dateKeepingTime(purchase.createdAt, $("#editDate").value),
      quantity: Number($("#editQuantity").value),
      unitCost: Number($("#editUnitCost").value),
      debtStatus: $("#editDebtStatus").value,
      debtPerson: $("#editDebtPerson").value.trim(),
      initialPaid: Number($("#editInitialPaid").value) || 0,
      note: $("#editNote").value.trim(),
      updatedAt: new Date().toISOString()
    });
  }
  if (type === "payments") {
    const payment = state.payments.find((row) => row.id === id);
    await put("payments", {
      ...payment,
      supplierId: $("#editSupplierId").value,
      createdAt: dateKeepingTime(payment.createdAt, $("#editDate").value),
      amount: Number($("#editAmount").value),
      note: $("#editNote").value.trim(),
      updatedAt: new Date().toISOString()
    });
  }
  if (type === "suppliers") {
    const supplier = state.suppliers.find((row) => row.id === id);
    await put("suppliers", {
      ...supplier,
      name: $("#editName").value.trim(),
      updatedAt: new Date().toISOString()
    });
  }
  $("#editDialog").close();
  pendingEdit = null;
  await loadState();
  renderAll();
  toast("Cambios guardados");
}

function requestDelete(type, id) {
  pendingDelete = { type, id };
  $("#pinInput").value = "";
  $("#pinDialog").showModal();
}

async function confirmDelete(event) {
  event.preventDefault();
  if ($("#pinInput").value !== ADMIN_PIN) {
    toast("Clave incorrecta");
    return;
  }
  const { type, id } = pendingDelete || {};
  if (!type || !id) return;
  if (type === "suppliers") {
    const supplier = state.suppliers.find((row) => row.id === id);
    await put("suppliers", { ...supplier, active: false, updatedAt: new Date().toISOString() });
  } else {
    await deleteById(type, id);
  }
  $("#pinDialog").close();
  pendingDelete = null;
  await loadState();
  renderAll();
  toast("Registro eliminado");
}

function backupPayload() {
  return {
    app: "laminas-mundial-pos",
    exportedAt: new Date().toISOString(),
    products: state.products,
    suppliers: state.suppliers,
    sales: state.sales,
    purchases: state.purchases,
    payments: state.payments,
    settings: state.settings
  };
}

function backupText() {
  return JSON.stringify(backupPayload(), null, 2);
}

async function copyBackup() {
  const text = $("#backupText").value || backupText();
  $("#backupText").value = text;
  $("#backupText").focus();
  $("#backupText").select();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast("Respaldo copiado");
      return;
    }
  } catch (error) {
    console.warn("No se pudo copiar con Clipboard API", error);
  }
  try {
    document.execCommand("copy");
    toast("Respaldo copiado");
  } catch (error) {
    toast("Selecciona el texto y cópialo manualmente");
  }
}

function exportData(showOnly = false) {
  const text = backupText();
  $("#backupText").value = text;
  if (showOnly) {
    toast("Respaldo listo para copiar");
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `respaldo-laminas-pos-${todayInputValue()}.json`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 1200);
  toast("Respaldo exportado");
}

async function importData(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  for (const name of STORE_NAMES) await clearStore(name);
  for (const product of payload.products || []) await put("products", product);
  for (const supplier of payload.suppliers || []) await put("suppliers", supplier);
  for (const sale of payload.sales || []) await put("sales", sale);
  for (const purchase of payload.purchases || []) await put("purchases", purchase);
  for (const payment of payload.payments || []) await put("payments", payment);
  await put("settings", { id: "main", ...(payload.settings || {}) });
  await loadState();
  renderAll();
  toast("Respaldo importado");
}

async function resetData() {
  if (!confirm("Esto borrará todos los datos locales de esta app. ¿Continuar?")) return;
  for (const name of STORE_NAMES) await clearStore(name);
  await loadState();
  renderAll();
  toast("Datos reiniciados");
}

function bindEvents() {
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${button.dataset.tab}View`));
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  $$("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => document.querySelector(`.tab[data-tab='${button.dataset.tabTarget}']`).click());
  });
  $("#backupBtn").addEventListener("click", () => exportData());
  $("#exportBtn").addEventListener("click", () => exportData());
  $("#showBackupBtn").addEventListener("click", () => exportData(true));
  $("#copyBackupBtn").addEventListener("click", () => copyBackup());
  $("#importFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importData(file).catch(() => toast("No se pudo importar"));
    event.target.value = "";
  });
  $("#resetBtn").addEventListener("click", resetData);
  $("#historyFilter").addEventListener("change", renderHistory);
  $("#dashboardMonth").addEventListener("change", renderDashboard);
  $("#saleQty").addEventListener("input", updateSalePreview);
  $("#salePrice").addEventListener("input", () => {
    state.settings.lastSalePrice = Number($("#salePrice").value) || state.settings.lastSalePrice;
    saveSettings();
    updateSalePreview();
    renderPriceButtons();
  });
  $("#purchaseQty").addEventListener("input", updatePurchasePreview);
  $("#purchaseCost").addEventListener("input", updatePurchasePreview);
  $("#purchasePaid").addEventListener("input", updatePurchasePreview);
  $$("input[name='purchaseDebtStatus']").forEach((input) => input.addEventListener("change", updatePurchasePreview));
  $("#addSalePricePresetBtn").addEventListener("click", async () => {
    const rawPrice = $("#newSalePricePreset").value;
    if (rawPrice === "") return;
    const price = Number(rawPrice);
    if (Number.isNaN(price) || price < 0) return;
    state.settings.salePricePresets = Array.from(new Set([...state.settings.salePricePresets, price]));
    state.settings.lastSalePrice = price;
    $("#salePrice").value = price;
    $("#newSalePricePreset").value = "";
    await saveSettings();
    renderPriceButtons();
    updateSalePreview();
  });
  $("#addProductBtn").addEventListener("click", async () => {
    const product = await addProduct($("#newProductName").value);
    $("#newProductName").value = "";
    renderSelectors();
    if (product) {
      $("#purchaseProduct").value = product.id;
      toast("Producto creado");
    }
  });
  $("#quickProductBtn").addEventListener("click", () => {
    document.querySelector(".tab[data-tab='buy']").click();
    $("#newProductName").focus();
  });
  $("#addSupplierBtn").addEventListener("click", async () => {
    const supplier = await addSupplier($("#newSupplierName").value);
    $("#newSupplierName").value = "";
    renderSelectors();
    if (supplier) {
      $("#paymentSupplier").value = supplier.id;
      $("#purchaseSupplier").value = supplier.id;
      toast("Proveedor creado");
    }
  });
  $("#saleForm").addEventListener("submit", saveSale);
  $("#purchaseForm").addEventListener("submit", savePurchase);
  $("#paymentForm").addEventListener("submit", savePayment);
  $("#editForm").addEventListener("submit", saveEdit);
  $("#cancelEditBtn").addEventListener("click", () => $("#editDialog").close());
  $("#pinForm").addEventListener("submit", confirmDelete);
  $("#cancelPinBtn").addEventListener("click", () => $("#pinDialog").close());
}

async function saveSale(event) {
  event.preventDefault();
  const sale = {
    id: uid("sale"),
    productId: $("#saleProduct").value,
    createdAt: inputDateToIso($("#saleDate").value),
    quantity: Number($("#saleQty").value),
    unitPrice: Number($("#salePrice").value),
    paymentStatus: activeRadioValue("salePaymentStatus"),
    note: $("#saleNote").value.trim()
  };
  await put("sales", sale);
  state.settings.lastSalePrice = sale.unitPrice;
  if (!state.settings.salePricePresets.includes(sale.unitPrice)) {
    state.settings.salePricePresets.push(sale.unitPrice);
  }
  await saveSettings();
  $("#saleQty").value = "";
  $("#saleNote").value = "";
  await loadState();
  renderAll();
  toast("Venta guardada");
}

async function savePurchase(event) {
  event.preventDefault();
  const status = activeRadioValue("purchaseDebtStatus");
  const purchase = {
    id: uid("purchase"),
    productId: $("#purchaseProduct").value,
    supplierId: $("#purchaseSupplier").value,
    createdAt: inputDateToIso($("#purchaseDate").value),
    quantity: Number($("#purchaseQty").value),
    unitCost: Number($("#purchaseCost").value) || 0,
    debtStatus: status,
    debtPerson: $("#purchaseDebtPerson").value.trim(),
    initialPaid: status === "debe" ? Number($("#purchasePaid").value) || 0 : purchaseTotal({ quantity: Number($("#purchaseQty").value), unitCost: Number($("#purchaseCost").value) }),
    note: $("#purchaseNote").value.trim()
  };
  await put("purchases", purchase);
  $("#purchaseQty").value = "";
  $("#purchaseCost").value = "";
  $("#purchasePaid").value = "0";
  $("#purchaseDebtPerson").value = "";
  $("#purchaseNote").value = "";
  await loadState();
  renderAll();
  toast("Compra guardada");
}

async function savePayment(event) {
  event.preventDefault();
  const payment = {
    id: uid("payment"),
    supplierId: $("#paymentSupplier").value,
    createdAt: inputDateToIso($("#paymentDate").value),
    amount: Number($("#paymentAmount").value),
    note: $("#paymentNote").value.trim()
  };
  await put("payments", payment);
  $("#paymentAmount").value = "";
  $("#paymentNote").value = "";
  await loadState();
  renderAll();
  toast("Pago registrado");
}

async function init() {
  db = await openDb();
  await loadState();
  bindEvents();
  renderAll();
  updateClock();
  setInterval(updateClock, 30000);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init().catch((error) => {
  console.error(error);
  toast("No se pudo iniciar la app");
});
