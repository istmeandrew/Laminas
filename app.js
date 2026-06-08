const DB_NAME = "laminas-mundial-pos-db";
const DB_VERSION = 2;
const APP_VERSION = "20260607-7";
const STORE_NAMES = ["products", "suppliers", "sales", "purchases", "payments", "customers", "reservations", "settings"];
const DEFAULT_PRODUCT_ID = "product-laminas-mundial";
const DEFAULT_SUPPLIER_ID = "supplier-general";
const ADMIN_PIN = "4818";
const SALE_PAYMENT_METHODS = ["efectivo", "tarjeta", "pendiente"];

let db;
let pendingDelete = null;
let pendingEdit = null;
let toastTimer;
let saleDraftItems = [];
let reservationDraftItems = [];
let whatsappBroadcastPrepared = false;
let lastTouchEnd = 0;
let touchStartX = 0;
let touchStartY = 0;
let touchHorizontalLocked = false;

const state = {
  products: [],
  suppliers: [],
  sales: [],
  purchases: [],
  payments: [],
  customers: [],
  reservations: [],
  settings: {
    salePricePresets: [500, 700, 1000, 1500],
    lastSalePrice: 1000,
    lastSaleProductId: DEFAULT_PRODUCT_ID,
    lastReservationProductId: DEFAULT_PRODUCT_ID
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

function units(value, label = "") {
  const n = Number(value) || 0;
  const text = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 0 }).format(n);
  if (!label) return text;
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

function searchableText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesSearchText(value, search) {
  const terms = searchableText(search).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = searchableText(value);
  return terms.every((term) => text.includes(term));
}

function chileMobileLocalDigits(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.startsWith("569")) digits = digits.slice(3);
  else if (digits.startsWith("56")) digits = digits.slice(2);
  if (digits.startsWith("9") && digits.length > 8) digits = digits.slice(1);
  return digits.slice(0, 8);
}

function formatChileMobilePhone(value) {
  const digits = chileMobileLocalDigits(value);
  if (!digits) return "";
  return `+56 9 ${digits.slice(0, 4)}${digits.length > 4 ? ` ${digits.slice(4)}` : ""}`.trim();
}

function whatsappUrl(phone, text = "") {
  const digits = chileMobileLocalDigits(phone);
  if (digits.length !== 8) return "";
  const base = `https://wa.me/569${digits}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

function whatsappIcon() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.02 3.2a8.55 8.55 0 0 0-7.28 13.05l-.94 3.42 3.51-.92a8.55 8.55 0 1 0 4.71-15.55Zm0 1.53a7.03 7.03 0 0 1 5.97 10.75 7.03 7.03 0 0 1-9.89 1.91l-.26-.16-2.1.55.56-2.04-.17-.27a7.03 7.03 0 0 1 5.89-10.74Zm-2.5 3.68c-.15 0-.39.05-.6.27-.2.22-.78.76-.78 1.86s.8 2.16.91 2.31c.11.15 1.55 2.48 3.82 3.38 1.89.75 2.28.6 2.69.56.41-.04 1.32-.54 1.51-1.06.19-.52.19-.97.13-1.06-.06-.09-.21-.15-.45-.27-.24-.12-1.4-.69-1.62-.77-.22-.08-.38-.12-.54.12-.16.24-.62.77-.76.93-.14.16-.28.18-.52.06-.24-.12-1.01-.37-1.93-1.19-.71-.63-1.19-1.41-1.33-1.65-.14-.24-.02-.37.1-.49.11-.1.24-.27.36-.4.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.2-.47-.39-.41-.54-.41h-.45Z"/>
    </svg>
  `;
}

function productName(id) {
  return state.products.find((product) => product.id === id)?.name || "Producto eliminado";
}

function supplierName(id) {
  return state.suppliers.find((supplier) => supplier.id === id)?.name || "Proveedor eliminado";
}

function customerName(id) {
  const customer = state.customers.find((row) => row.id === id);
  if (!customer) return "Cliente eliminado";
  return `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || "Cliente sin nombre";
}

function customerFirstName(customer) {
  return (customer?.firstName || customerName(customer?.id).split(/\s+/)[0] || "cliente").trim();
}

function paymentStatusLabel(status) {
  if (status === "tarjeta") return "Tarjeta";
  if (status === "pendiente") return "Pendiente de pago";
  return "Efectivo";
}

function paymentMethodLabel(method) {
  return method === "tarjeta" ? "Tarjeta" : paymentStatusLabel(method);
}

function emptySalePaymentBreakdown() {
  return { efectivo: 0, tarjeta: 0, pendiente: 0 };
}

function salePaymentBreakdown(sale) {
  const total = saleTotal(sale);
  const breakdown = emptySalePaymentBreakdown();
  if (sale.paymentBreakdown && typeof sale.paymentBreakdown === "object") {
    for (const method of SALE_PAYMENT_METHODS) {
      breakdown[method] = Math.max(0, Number(sale.paymentBreakdown[method]) || 0);
    }
    if (Object.values(breakdown).some((amount) => amount > 0) || total === 0) return breakdown;
  }
  const status = SALE_PAYMENT_METHODS.includes(sale.paymentStatus) ? sale.paymentStatus : "efectivo";
  breakdown[status] = total;
  return breakdown;
}

function salePendingAmount(sale) {
  return salePaymentBreakdown(sale).pendiente || 0;
}

function paymentStatusFromBreakdown(breakdown) {
  const methods = SALE_PAYMENT_METHODS.filter((method) => (Number(breakdown[method]) || 0) > 0);
  if (methods.length === 1) return methods[0];
  if (methods.length > 1) return "mixto";
  return "efectivo";
}

function salePaymentLabel(sale) {
  const breakdown = salePaymentBreakdown(sale);
  const methods = SALE_PAYMENT_METHODS.filter((method) => (Number(breakdown[method]) || 0) > 0);
  if (!methods.length) return paymentStatusLabel(sale.paymentStatus);
  if (methods.length === 1) return paymentMethodLabel(methods[0]);
  return methods.map((method) => `${paymentMethodLabel(method)} ${money(breakdown[method])}`).join(" · ");
}

function activeProducts() {
  return state.products.filter((product) => product.active !== false).sort((a, b) => a.name.localeCompare(b.name));
}

function activeSuppliers() {
  return state.suppliers.filter((supplier) => supplier.active !== false).sort((a, b) => a.name.localeCompare(b.name));
}

function activeCustomers() {
  return state.customers.filter((customer) => customer.active !== false).sort((a, b) => customerName(a.id).localeCompare(customerName(b.id)));
}

function normalizeItems(row) {
  if (Array.isArray(row.items) && row.items.length) {
    return row.items
      .map((item) => ({
        productId: item.productId,
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0
      }))
      .filter((item) => item.productId && item.quantity > 0);
  }
  const quantity = Number(row.quantity) || 0;
  if (!row.productId || quantity <= 0) return [];
  return [{ productId: row.productId, quantity, unitPrice: Number(row.unitPrice) || 0 }];
}

function saleItems(sale) {
  return normalizeItems(sale);
}

function reservationItems(reservation) {
  return normalizeItems(reservation);
}

function itemsTotal(items) {
  return items.reduce((sum, item) => sum + ((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0)), 0);
}

function itemsQuantity(items) {
  return items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
}

function primaryProductId(items) {
  return items[0]?.productId || "";
}

function averageUnitPrice(items) {
  const quantity = itemsQuantity(items);
  return quantity > 0 ? Math.round(itemsTotal(items) / quantity) : 0;
}

function itemsSummary(items) {
  if (!items.length) return "Sin productos";
  if (items.length === 1) return `${productName(items[0].productId)} · ${units(items[0].quantity)}`;
  const names = items.slice(0, 2).map((item) => `${productName(item.productId)} (${units(item.quantity)})`);
  const extra = items.length > 2 ? ` +${items.length - 2} más` : "";
  return `${items.length} productos · ${names.join(" · ")}${extra}`;
}

function saleTotal(sale) {
  return itemsTotal(saleItems(sale));
}

function reservationTotal(reservation) {
  return itemsTotal(reservationItems(reservation));
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
    for (const item of saleItems(sale)) {
      if (!stock.has(item.productId)) {
        stock.set(item.productId, { product: { id: item.productId, name: productName(item.productId) }, bought: 0, sold: 0, stock: 0, avgCost: 0, costTotal: 0 });
      }
      stock.get(item.productId).sold += Number(item.quantity) || 0;
    }
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

function pendingReservations() {
  return state.reservations.filter((reservation) => reservation.status !== "entregado");
}

function customersWithPendingReservations() {
  const customerIds = new Set(pendingReservations().map((reservation) => reservation.customerId).filter(Boolean));
  return activeCustomers().filter((customer) => customerIds.has(customer.id));
}

function reservedByProduct(ignoreReservationId = null) {
  const reserved = new Map();
  for (const reservation of pendingReservations()) {
    if (reservation.id === ignoreReservationId) continue;
    for (const item of reservationItems(reservation)) {
      reserved.set(item.productId, (reserved.get(item.productId) || 0) + (Number(item.quantity) || 0));
    }
  }
  return reserved;
}

function availableStockByProduct(ignoreReservationId = null) {
  const reserved = reservedByProduct(ignoreReservationId);
  return stockByProduct().map((row) => {
    const reservedUnits = reserved.get(row.product.id) || 0;
    return {
      ...row,
      reserved: reservedUnits,
      available: row.stock - reservedUnits
    };
  });
}

function totalAvailableStock() {
  return availableStockByProduct().reduce((sum, row) => sum + row.available, 0);
}

function stockAvailabilityIssue(items, ignoreReservationId = null) {
  const neededByProduct = new Map();
  for (const item of items) {
    neededByProduct.set(item.productId, (neededByProduct.get(item.productId) || 0) + (Number(item.quantity) || 0));
  }
  const availableRows = availableStockByProduct(ignoreReservationId);
  for (const [productId, needed] of neededByProduct) {
    const row = availableRows.find((stockRow) => stockRow.product.id === productId);
    const available = row?.available || 0;
    if (needed > available) {
      return `Stock disponible insuficiente en ${productName(productId)}: quedan ${units(available)}`;
    }
  }
  return "";
}

async function loadState() {
  const [products, suppliers, sales, purchases, payments, customers, reservations, settingsRows] = await Promise.all([
    getAll("products"),
    getAll("suppliers"),
    getAll("sales"),
    getAll("purchases"),
    getAll("payments"),
    getAll("customers"),
    getAll("reservations"),
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
  state.customers = customers.sort((a, b) => `${a.firstName || ""} ${a.lastName || ""}`.localeCompare(`${b.firstName || ""} ${b.lastName || ""}`));
  state.reservations = reservations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
  for (const input of ["#saleDate", "#reservationDate", "#purchaseDate", "#paymentDate"]) {
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
  const customers = activeCustomers();
  fillSelect($("#saleProduct"), products, (product) => product.name);
  if (products.some((product) => product.id === state.settings.lastSaleProductId)) {
    $("#saleProduct").value = state.settings.lastSaleProductId;
  }
  fillSelect($("#reservationProduct"), products, (product) => product.name);
  if (products.some((product) => product.id === state.settings.lastReservationProductId)) {
    $("#reservationProduct").value = state.settings.lastReservationProductId;
  }
  fillSelect($("#reservationCustomer"), customers, (customer) => {
    const phone = customer.phone ? ` · ${customer.phone}` : "";
    return `${customerName(customer.id)}${phone}`;
  });
  fillSelect($("#purchaseProduct"), products, (product) => product.name);
  fillSelect($("#purchaseSupplier"), suppliers, (supplier) => supplier.name);
  fillSelect($("#paymentSupplier"), suppliers.map((supplier) => ({ ...supplier, debt: supplierDebt(supplier.id) })), (supplier) => {
    const debt = supplier.debt;
    return `${supplier.name} · ${debt < 0 ? "saldo a favor " : "deuda "}${money(Math.abs(debt))}`;
  });
  const defaultPrice = state.settings.lastSalePrice ?? state.settings.salePricePresets[0] ?? 1000;
  if (!$("#salePrice").value) $("#salePrice").value = defaultPrice;
  if (!$("#reservationPrice").value) $("#reservationPrice").value = defaultPrice;
  renderPriceButtons();
}

function readFormItem(productSelector, quantitySelector, priceSelector) {
  const quantity = Number($(quantitySelector).value) || 0;
  if (quantity <= 0) return null;
  return {
    productId: $(productSelector).value,
    quantity,
    unitPrice: Number($(priceSelector).value) || 0
  };
}

function mergeDraftItem(items, item) {
  const existing = items.find((row) => row.productId === item.productId && row.unitPrice === item.unitPrice);
  if (existing) {
    existing.quantity += item.quantity;
  } else {
    items.push({ ...item, draftId: uid("draft") });
  }
}

function draftItemsForSubmit(items, currentItem) {
  const result = items.map((item) => ({ productId: item.productId, quantity: Number(item.quantity) || 0, unitPrice: Number(item.unitPrice) || 0 }));
  if (currentItem) mergeDraftItem(result, currentItem);
  return result
    .filter((item) => item.productId && item.quantity > 0)
    .map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice }));
}

function renderDraftItems() {
  const renderRows = (items, removeAttr) => items.map((item) => `
    <article class="draft-item">
      <div>
        <strong>${escapeHtml(productName(item.productId))}</strong>
        <span>${units(item.quantity)} · ${money(item.unitPrice)} c/u</span>
      </div>
      <div>
        <strong>${money((Number(item.quantity) || 0) * (Number(item.unitPrice) || 0))}</strong>
        <button class="action-button delete" type="button" ${removeAttr}="${item.draftId}" title="Quitar">×</button>
      </div>
    </article>
  `).join("");

  $("#saleItemsList").innerHTML = saleDraftItems.length ? renderRows(saleDraftItems, "data-remove-sale-draft") : "";
  $("#reservationItemsList").innerHTML = reservationDraftItems.length ? renderRows(reservationDraftItems, "data-remove-reservation-draft") : "";
  $("#saleItemsList").querySelectorAll("[data-remove-sale-draft]").forEach((button) => {
    button.addEventListener("click", () => {
      saleDraftItems = saleDraftItems.filter((item) => item.draftId !== button.dataset.removeSaleDraft);
      renderDraftItems();
      updateSalePreview();
    });
  });
  $("#reservationItemsList").querySelectorAll("[data-remove-reservation-draft]").forEach((button) => {
    button.addEventListener("click", () => {
      reservationDraftItems = reservationDraftItems.filter((item) => item.draftId !== button.dataset.removeReservationDraft);
      renderDraftItems();
      updateReservationPreview();
    });
  });
}

function addCurrentSaleItemToDraft() {
  const item = readFormItem("#saleProduct", "#saleQty", "#salePrice");
  if (!item) {
    toast("Agrega cantidad para sumar otro producto");
    return;
  }
  mergeDraftItem(saleDraftItems, item);
  state.settings.lastSaleProductId = item.productId;
  saveSettings();
  $("#saleQty").value = "";
  renderDraftItems();
  updateSalePreview();
}

function addCurrentReservationItemToDraft() {
  const item = readFormItem("#reservationProduct", "#reservationQty", "#reservationPrice");
  if (!item) {
    toast("Agrega cantidad para sumar otro producto");
    return;
  }
  mergeDraftItem(reservationDraftItems, item);
  state.settings.lastReservationProductId = item.productId;
  saveSettings();
  $("#reservationQty").value = "";
  renderDraftItems();
  updateReservationPreview();
}

function currentSaleTotal() {
  const current = readFormItem("#saleProduct", "#saleQty", "#salePrice");
  return itemsTotal(draftItemsForSubmit(saleDraftItems, current));
}

function selectedSalePaymentMethods() {
  return $$("input[name='salePaymentMethods']:checked").map((input) => input.value);
}

function syncSalePaymentSplit() {
  const selected = selectedSalePaymentMethods();
  if (!selected.length) {
    const fallback = $("input[name='salePaymentMethods'][value='efectivo']");
    fallback.checked = true;
    selected.push("efectivo");
  }
  const total = currentSaleTotal();
  const useSplit = selected.length > 1;
  $("#salePaymentSplit").classList.toggle("hidden", !useSplit);
  $("#salePaymentSplitTotal").textContent = money(total);
  for (const method of SALE_PAYMENT_METHODS) {
    const row = $(`[data-sale-payment-row='${method}']`);
    if (row) row.classList.toggle("hidden", !selected.includes(method));
  }
  if (!useSplit) {
    for (const input of ["#salePaymentCash", "#salePaymentCard", "#salePaymentPending"]) {
      $(input).value = "";
    }
    $("#salePaymentSplitHint").textContent = "Selecciona dos o más métodos para repartir el monto.";
    return;
  }
  const sum = paymentSplitInputTotal(selected);
  const diff = total - sum;
  $("#salePaymentSplitHint").textContent = diff === 0
    ? "Reparto completo."
    : diff > 0
      ? `Falta por repartir ${money(diff)}.`
      : `Sobra ${money(Math.abs(diff))}.`;
}

function updateSalePreview() {
  $("#salePreview").textContent = money(currentSaleTotal());
  syncSalePaymentSplit();
}

function paymentInputSelector(method) {
  return {
    efectivo: "#salePaymentCash",
    tarjeta: "#salePaymentCard",
    pendiente: "#salePaymentPending"
  }[method];
}

function paymentSplitInputTotal(methods = SALE_PAYMENT_METHODS) {
  return methods.reduce((sum, method) => sum + (Number($(paymentInputSelector(method)).value) || 0), 0);
}

function readSalePaymentBreakdown(total) {
  const selected = selectedSalePaymentMethods();
  if (!selected.length) return { error: "Selecciona al menos un método de pago" };
  const breakdown = emptySalePaymentBreakdown();
  if (selected.length === 1) {
    breakdown[selected[0]] = total;
    return { breakdown };
  }
  for (const method of selected) {
    breakdown[method] = Number($(paymentInputSelector(method)).value) || 0;
  }
  const sum = Object.values(breakdown).reduce((totalAmount, amount) => totalAmount + amount, 0);
  if (total > 0 && selected.some((method) => breakdown[method] <= 0)) {
    return { error: "Agrega un monto mayor a 0 en cada método seleccionado" };
  }
  if (sum !== total) {
    return { error: `Los pagos deben sumar ${money(total)}. Ahora suman ${money(sum)}` };
  }
  return { breakdown };
}

function adjustQuantity(selector, delta, onChange) {
  const input = $(selector);
  const current = Number(input.value) || 0;
  input.value = Math.max(1, current + delta);
  onChange();
}

function updateReservationPreview() {
  const current = readFormItem("#reservationProduct", "#reservationQty", "#reservationPrice");
  $("#reservationPreview").textContent = money(itemsTotal(draftItemsForSubmit(reservationDraftItems, current)));
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
  const todayUnits = todaySales.reduce((sum, sale) => sum + itemsQuantity(saleItems(sale)), 0);
  const receivable = state.sales.reduce((sum, sale) => sum + salePendingAmount(sale), 0);
  const availableRows = availableStockByProduct();
  const stock = availableRows.reduce((sum, row) => sum + row.available, 0);
  const breakdown = availableRows
    .filter((row) => row.bought > 0 || row.sold > 0 || row.reserved > 0 || row.available !== 0)
    .map((row) => `${row.product.name}: ${units(row.available)}`)
    .join(" · ");
  $("#topTodaySales").textContent = money(todayTotal);
  $("#topTodayUnits").textContent = `${units(todayUnits)} vendidos`;
  $("#topStock").textContent = units(stock);
  $("#topStockBreakdown").textContent = breakdown || "Sin productos disponibles";
  $("#topReceivable").textContent = money(receivable);
}

function saleMeta(sale) {
  const note = sale.note ? ` · ${sale.note}` : "";
  return `${dateTime(sale.createdAt)} · ${itemsSummary(saleItems(sale))} · ${salePaymentLabel(sale)}${note}`;
}

function purchaseMeta(purchase) {
  const debt = purchase.debtStatus === "debe" ? Math.max(0, purchaseTotal(purchase) - (Number(purchase.initialPaid) || 0)) : 0;
  const debtText = debt > 0 ? ` · debe ${money(debt)}` : " · pagado";
  const person = purchase.debtPerson ? ` · ${purchase.debtPerson}` : "";
  return `${shortDate(purchase.createdAt)} · ${productName(purchase.productId)} · ${units(purchase.quantity)} · ${supplierName(purchase.supplierId)}${debtText}${person}`;
}

function reservationMeta(reservation) {
  const status = reservation.status === "entregado" ? "entregada" : "pendiente";
  const payment = paymentStatusLabel(reservation.paymentStatus);
  const note = reservation.note ? ` · ${reservation.note}` : "";
  const phone = state.customers.find((customer) => customer.id === reservation.customerId)?.phone;
  return `${shortDate(reservation.createdAt)} · ${itemsSummary(reservationItems(reservation))} · ${customerName(reservation.customerId)}${phone ? ` · ${phone}` : ""} · ${payment} · ${status}${note}`;
}

function reservationProductLines(reservation) {
  return reservationItems(reservation).map((item) => `
    <span class="reservation-product-line">
      <strong>${escapeHtml(productName(item.productId))}</strong>
      <em>${units(item.quantity)}</em>
    </span>
  `).join("");
}

function reservationInfoLine(reservation) {
  const payment = paymentStatusLabel(reservation.paymentStatus);
  const note = reservation.note ? ` · ${reservation.note}` : "";
  const customer = state.customers.find((row) => row.id === reservation.customerId);
  return `${shortDate(reservation.createdAt)}${customer?.phone ? ` · ${customer.phone}` : ""} · ${payment}${note}`;
}

function reservationWhatsappAction(reservation, message = "") {
  const customer = state.customers.find((row) => row.id === reservation.customerId);
  const url = whatsappUrl(customer?.phone, message);
  if (!url) return "";
  return `<a class="action-button whatsapp-button" href="${url}" target="_blank" rel="noopener" title="Abrir WhatsApp" aria-label="Abrir WhatsApp">${whatsappIcon()}</a>`;
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

function reservationCardHtml(reservation) {
  const delivered = reservation.status === "entregado";
  const info = `${reservationInfoLine(reservation)}${delivered && reservation.deliveredAt ? ` · venta ${dateTime(reservation.deliveredAt)}` : ""}`;
  return `
    <article class="list-item reservation-item ${delivered ? "delivered" : ""}">
      <div class="reservation-content">
        <div class="reservation-heading">
          <span class="reservation-customer-name">${escapeHtml(customerName(reservation.customerId))}</span>
          <span class="status-pill ${delivered ? "done" : "pending"}">${delivered ? "Entregada" : "Pendiente"}</span>
        </div>
        <div class="reservation-product-lines">${reservationProductLines(reservation)}</div>
        <span class="reservation-info">${money(reservationTotal(reservation))} · ${escapeHtml(info)}</span>
      </div>
      <div class="item-actions ${delivered ? "" : "wide-actions"}">
        ${delivered ? "" : `<button class="secondary deliver-button" type="button" data-deliver-reservation="${reservation.id}">Entregado</button>`}
        ${reservationWhatsappAction(reservation)}
        <button class="action-button" data-edit-reservation="${reservation.id}" title="Modificar">✎</button>
        <button class="action-button delete" data-delete-reservation="${reservation.id}" title="Eliminar">×</button>
      </div>
    </article>
  `;
}

function bindReservationActions(container) {
  container.querySelectorAll("[data-deliver-reservation]").forEach((button) => {
    button.addEventListener("click", () => deliverReservation(button.dataset.deliverReservation));
  });
  container.querySelectorAll("[data-edit-reservation]").forEach((button) => {
    button.addEventListener("click", () => openEdit("reservations", button.dataset.editReservation));
  });
  container.querySelectorAll("[data-delete-reservation]").forEach((button) => {
    button.addEventListener("click", () => requestDelete("reservations", button.dataset.deleteReservation));
  });
}

function renderReservations() {
  const pending = pendingReservations();
  const delivered = state.reservations.filter((reservation) => reservation.status === "entregado").slice(0, 8);
  $("#reservationPendingTotal").textContent = `${pending.length} ${pending.length === 1 ? "pendiente" : "pendientes"}`;
  renderList($("#reservationList"), [...pending, ...delivered].map(reservationCardHtml), "Aún no hay reservas.");
  bindReservationActions($("#reservationList"));
}

function renderReservationCustomerSearch() {
  const search = $("#reservationCustomerSearch").value || "";
  const hasSearch = Boolean(search.trim());
  if (!hasSearch) {
    $("#reservedCustomerCount").textContent = "Buscar";
    $("#reservationCustomerMatches").innerHTML = "";
    return;
  }

  const rows = pendingReservations().filter((reservation) => {
    const customer = state.customers.find((row) => row.id === reservation.customerId);
    const text = `${customerName(reservation.customerId)} ${customer?.phone || ""} ${chileMobileLocalDigits(customer?.phone)}`;
    return matchesSearchText(text, search);
  });

  $("#reservedCustomerCount").textContent = `${rows.length} ${rows.length === 1 ? "resultado" : "resultados"}`;
  renderList($("#reservationCustomerMatches"), rows.map(reservationCardHtml), "No encontré reservas para ese cliente.");
  bindReservationActions($("#reservationCustomerMatches"));
}

function reservationBroadcastRows() {
  return customersWithPendingReservations().map((customer) => {
    const reservations = pendingReservations().filter((reservation) => reservation.customerId === customer.id);
    const products = new Map();
    for (const reservation of reservations) {
      for (const item of reservationItems(reservation)) {
        products.set(item.productId, (products.get(item.productId) || 0) + (Number(item.quantity) || 0));
      }
    }
    const productSummary = Array.from(products.entries())
      .map(([productId, quantity]) => `${productName(productId)}: ${units(quantity)}`)
      .join(" · ");
    return {
      customer,
      reservations,
      productSummary,
      totalReserved: reservations.reduce((sum, reservation) => sum + itemsQuantity(reservationItems(reservation)), 0)
    };
  });
}

function reservationBroadcastMessage(customer, template) {
  return (template || "")
    .replaceAll("{nombre}", customerFirstName(customer))
    .replaceAll("{Nombre}", customerFirstName(customer))
    .replaceAll("{cliente}", customerName(customer.id))
    .replaceAll("{Cliente}", customerName(customer.id));
}

function renderReservationBroadcast() {
  const rows = reservationBroadcastRows();
  $("#reservationBroadcastCount").textContent = `${rows.length} ${rows.length === 1 ? "cliente" : "clientes"}`;
  if (!whatsappBroadcastPrepared) {
    $("#reservationBroadcastList").innerHTML = "";
    return;
  }
  const template = $("#reservationBroadcastMessage").value.trim();
  renderList(
    $("#reservationBroadcastList"),
    rows.map((row) => {
      const message = reservationBroadcastMessage(row.customer, template);
      const url = whatsappUrl(row.customer.phone, message);
      return `
        <article class="list-item broadcast-item">
          <div class="list-main">
            <span class="list-title">${escapeHtml(customerName(row.customer.id))}</span>
            <span class="item-meta">${escapeHtml(row.customer.phone || "Sin teléfono")} · ${row.reservations.length} ${row.reservations.length === 1 ? "reserva" : "reservas"} · ${units(row.totalReserved)}</span>
            <span class="broadcast-preview">${escapeHtml(message)}</span>
            <span class="item-meta">${escapeHtml(row.productSummary || "Sin productos")}</span>
          </div>
          <div class="item-actions">
            ${url ? `<a class="action-button whatsapp-button" href="${url}" target="_blank" rel="noopener" title="Enviar WhatsApp" aria-label="Enviar WhatsApp">${whatsappIcon()}</a>` : `<span class="status-pill pending">Sin teléfono</span>`}
          </div>
        </article>
      `;
    }),
    "No hay clientes con reservas pendientes."
  );
}

function renderInventory() {
  const rows = availableStockByProduct();
  const html = rows.map((row) => `
    <article class="list-item">
      <div class="list-main">
        <span class="list-title">${row.product.name}</span>
        <span class="item-meta">Físico ${units(row.stock)} · Reservado ${units(row.reserved)} · Vendidos ${units(row.sold)} · Costo prom. ${money(row.avgCost)}</span>
      </div>
      <strong>${units(row.available)}</strong>
    </article>
  `);
  renderList($("#inventoryList"), html, "Aún no hay inventario.");
}

function allMonthKeys() {
  const keys = new Set([monthKey(new Date())]);
  for (const row of [...state.sales, ...state.purchases, ...state.payments]) keys.add(monthKey(row.createdAt));
  return Array.from(keys).sort().reverse();
}

function dashboardRange(key) {
  if (key !== "all") return monthRange(key);
  return { start: new Date(0), end: new Date(8640000000000000) };
}

function renderDashboard() {
  const select = $("#dashboardMonth");
  const current = select.value || monthKey(new Date());
  const keys = allMonthKeys();
  select.innerHTML = [
    `<option value="all">Todo</option>`,
    ...keys.map((key) => `<option value="${key}">${monthLabel(key)}</option>`)
  ].join("");
  select.value = current === "all" ? "all" : keys.includes(current) ? current : keys[0];
  const { start, end } = dashboardRange(select.value);
  const sales = state.sales.filter((sale) => isInRange(sale.createdAt, start, end));
  const purchases = state.purchases.filter((purchase) => isInRange(purchase.createdAt, start, end));
  const salesTotal = sales.reduce((sum, sale) => sum + saleTotal(sale), 0);
  const purchasesTotal = purchases.reduce((sum, purchase) => sum + purchaseTotal(purchase), 0);
  const sold = sales.reduce((sum, sale) => sum + itemsQuantity(saleItems(sale)), 0);
  const bought = purchases.reduce((sum, purchase) => sum + (Number(purchase.quantity) || 0), 0);
  const cash = sales.reduce((sum, sale) => sum + salePaymentBreakdown(sale).efectivo, 0);
  const card = sales.reduce((sum, sale) => sum + salePaymentBreakdown(sale).tarjeta, 0);
  const pending = sales.reduce((sum, sale) => sum + salePendingAmount(sale), 0);
  const pendingRows = sales.filter((sale) => salePendingAmount(sale) > 0);
  const providerDebt = activeSuppliers().reduce((sum, supplier) => sum + Math.max(0, supplierDebt(supplier.id)), 0);
  const stockRows = stockByProduct();
  const availableRows = availableStockByProduct();
  const stockTotal = stockRows.reduce((sum, row) => sum + row.stock, 0);
  const availableTotal = availableRows.reduce((sum, row) => sum + row.available, 0);
  const reservations = pendingReservations();
  const reservedUnits = reservations.reduce((sum, reservation) => sum + itemsQuantity(reservationItems(reservation)), 0);
  const reservedValue = reservations.reduce((sum, reservation) => sum + reservationTotal(reservation), 0);
  const reservationClients = new Set(reservations.map((reservation) => reservation.customerId).filter(Boolean));
  const lowStock = availableRows.filter((row) => row.available <= 10);
  const avgCostByProduct = new Map(stockRows.map((row) => [row.product.id, row.avgCost || 0]));
  const estimatedCostOfSold = sales.reduce((sum, sale) => {
    return sum + saleItems(sale).reduce((itemSum, item) => itemSum + ((Number(item.quantity) || 0) * (avgCostByProduct.get(item.productId) || 0)), 0);
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
  $("#monthSold").textContent = `${units(sold)} vendidos`;
  $("#monthAverage").textContent = money(sales.length ? salesTotal / sales.length : 0);
  $("#dashboardStockTotal").textContent = units(stockTotal);
  $("#reservedUnitsTotal").textContent = units(reservedUnits);
  $("#availableAfterReservations").textContent = units(availableTotal);
  $("#reservedValueTotal").textContent = money(reservedValue);
  $("#reservationClientCount").textContent = `${reservationClients.size} ${reservationClients.size === 1 ? "cliente" : "clientes"}`;
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

  renderDailyPaymentSummary();
  renderReservedProducts(reservations);
  renderMonthlyTrend(select.value === "all" ? monthKey(new Date()) : select.value);
  renderTopProducts(sales, avgCostByProduct);
  renderBusinessAlerts({ pendingRows, lowStock, providerDebt, grossProfit, salesTotal, availableTotal });
}

function renderReservedProducts(reservations) {
  const byProduct = new Map();
  for (const reservation of reservations) {
    for (const item of reservationItems(reservation)) {
      const row = byProduct.get(item.productId) || { productId: item.productId, quantity: 0, value: 0, customers: new Set(), reservations: 0 };
      const qty = Number(item.quantity) || 0;
      row.quantity += qty;
      row.value += qty * (Number(item.unitPrice) || 0);
      if (reservation.customerId) row.customers.add(reservation.customerId);
      row.reservations += 1;
      byProduct.set(item.productId, row);
    }
  }
  const rows = Array.from(byProduct.values()).sort((a, b) => b.quantity - a.quantity);
  $("#reservationCountLabel").textContent = `${reservations.length} ${reservations.length === 1 ? "reserva" : "reservas"}`;
  renderList(
    $("#reservedProductsList"),
    rows.map((row) => `
      <article class="list-item product-rank">
        <div class="list-main">
          <span class="list-title">${escapeHtml(productName(row.productId))}</span>
          <span class="item-meta">${units(row.quantity)} reservados · ${row.customers.size} ${row.customers.size === 1 ? "cliente" : "clientes"} · ${row.reservations} ${row.reservations === 1 ? "reserva" : "reservas"}</span>
        </div>
        <strong>${money(row.value)}</strong>
      </article>
    `),
    "No hay productos reservados."
  );
}

function renderDailyPaymentSummary() {
  const input = $("#dailyPaymentDate");
  if (!input.value) input.value = todayInputValue();
  const [year, month, day] = input.value.split("-").map(Number);
  const start = startOfDay(new Date(year, month - 1, day));
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const sales = state.sales.filter((sale) => isInRange(sale.createdAt, start, end));
  const groups = {
    efectivo: { amount: 0, units: 0 },
    tarjeta: { amount: 0, units: 0 },
    pendiente: { amount: 0, units: 0 }
  };
  const productRows = new Map();
  for (const sale of sales) {
    const saleAmount = saleTotal(sale);
    const saleUnits = itemsQuantity(saleItems(sale));
    const salePayments = salePaymentBreakdown(sale);
    for (const method of SALE_PAYMENT_METHODS) {
      const amount = salePayments[method] || 0;
      if (amount <= 0) continue;
      groups[method].amount += amount;
      groups[method].units += saleAmount > 0 ? Math.round(saleUnits * (amount / saleAmount)) : saleUnits;
    }
    for (const item of saleItems(sale)) {
      const row = productRows.get(item.productId) || {
        productId: item.productId,
        quantity: 0,
        amount: 0,
        payments: { efectivo: 0, tarjeta: 0, pendiente: 0 }
      };
      const qty = Number(item.quantity) || 0;
      const amount = qty * (Number(item.unitPrice) || 0);
      row.quantity += qty;
      row.amount += amount;
      for (const method of SALE_PAYMENT_METHODS) {
        const paymentAmount = salePayments[method] || 0;
        if (paymentAmount <= 0) continue;
        row.payments[method] += saleAmount > 0 ? Math.round(amount * (paymentAmount / saleAmount)) : 0;
      }
      productRows.set(item.productId, row);
    }
  }
  $("#todayCash").textContent = money(groups.efectivo.amount);
  $("#todayCashUnits").textContent = `${units(groups.efectivo.units)} vendidos`;
  $("#todayCard").textContent = money(groups.tarjeta.amount);
  $("#todayCardUnits").textContent = `${units(groups.tarjeta.units)} vendidos`;
  $("#todayPending").textContent = money(groups.pendiente.amount);
  $("#todayPendingUnits").textContent = `${units(groups.pendiente.units)} pendientes`;
  renderDailyProductSales(Array.from(productRows.values()));
}

function renderDailyProductSales(rows) {
  const sorted = rows.sort((a, b) => b.amount - a.amount);
  $("#dailyProductCount").textContent = `${sorted.length} ${sorted.length === 1 ? "producto" : "productos"}`;
  renderList(
    $("#dailyProductSalesList"),
    sorted.map((row) => {
      const paymentParts = Object.entries(row.payments)
        .filter(([, amount]) => amount > 0)
        .map(([name, amount]) => `${paymentMethodLabel(name)}: ${money(amount)}`)
        .join(" · ");
      return `
        <article class="list-item product-rank">
          <div class="list-main">
            <span class="list-title">${escapeHtml(productName(row.productId))}</span>
            <span class="item-meta">${units(row.quantity)} vendidos${paymentParts ? ` · ${paymentParts}` : ""}</span>
          </div>
          <strong>${money(row.amount)}</strong>
        </article>
      `;
    }),
    "No hay ventas de productos en esta fecha."
  );
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
    for (const item of saleItems(sale)) {
      const row = byProduct.get(item.productId) || { productId: item.productId, quantity: 0, revenue: 0, profit: 0 };
      const qty = Number(item.quantity) || 0;
      const revenue = qty * (Number(item.unitPrice) || 0);
      row.quantity += qty;
      row.revenue += revenue;
      row.profit += revenue - (qty * (avgCostByProduct.get(item.productId) || 0));
      byProduct.set(item.productId, row);
    }
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

function renderBusinessAlerts({ pendingRows, lowStock, providerDebt, grossProfit, salesTotal, availableTotal }) {
  const alerts = [];
  if (pendingRows.length) {
    const total = pendingRows.reduce((sum, sale) => sum + salePendingAmount(sale), 0);
    alerts.push({
      title: "Cobros pendientes",
      meta: `${pendingRows.length} ventas por cobrar · ${money(total)}`
    });
  }
  if (lowStock.length) {
    alerts.push({
      title: "Stock bajo",
      meta: lowStock.slice(0, 4).map((row) => `${row.product.name}: ${units(row.available)} disponibles`).join(" · ")
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
  if (availableTotal <= 10) {
    alerts.push({
      title: "Inventario muy ajustado",
      meta: `Quedan ${units(availableTotal)} disponibles en total.`
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
  if (filter === "reservations") {
    rows = state.reservations.map((reservation) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${money(reservationTotal(reservation))}</span>
          <span class="item-meta">${reservationMeta(reservation)}</span>
        </div>
        ${historyActions("reservations", reservation.id)}
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
    rows = state.sales.filter((sale) => salePendingAmount(sale) > 0).map((sale) => `
      <article class="list-item">
        <div class="list-main">
          <span class="list-title">${sale.note || "Cliente sin nombre"}</span>
          <span class="item-meta">${money(salePendingAmount(sale))} pendiente · ${dateTime(sale.createdAt)} · ${itemsSummary(saleItems(sale))}</span>
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
  renderReservations();
  renderReservationCustomerSearch();
  renderReservationBroadcast();
  renderInventory();
  renderDashboard();
  renderHistory();
  renderDraftItems();
  updateSalePreview();
  updateReservationPreview();
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

async function addCustomer(firstName, lastName, phone) {
  const cleanFirstName = firstName.trim();
  const cleanLastName = lastName.trim();
  const cleanPhone = formatChileMobilePhone(phone);
  if (!cleanFirstName || !cleanLastName) return null;
  const fullName = `${cleanFirstName} ${cleanLastName}`.toLowerCase();
  const existing = activeCustomers().find((customer) => `${customer.firstName || ""} ${customer.lastName || ""}`.trim().toLowerCase() === fullName);
  if (existing) {
    if (cleanPhone && existing.phone !== cleanPhone) {
      const updated = { ...existing, phone: cleanPhone, updatedAt: new Date().toISOString() };
      await put("customers", updated);
      await loadState();
      return updated;
    }
    return existing;
  }
  const customer = {
    id: uid("customer"),
    firstName: cleanFirstName,
    lastName: cleanLastName,
    phone: cleanPhone,
    active: true,
    createdAt: new Date().toISOString()
  };
  await put("customers", customer);
  await loadState();
  return customer;
}

function editField(label, id, type, value, attrs = "") {
  return `<label>${label}<input id="${id}" type="${type}" value="${String(value ?? "").replaceAll('"', "&quot;")}" ${attrs}></label>`;
}

function editSelect(label, id, rows, value, getLabel) {
  return `<label>${label}<select id="${id}">${rows.map((row) => `<option value="${row.id}" ${row.id === value ? "selected" : ""}>${getLabel(row)}</option>`).join("")}</select></label>`;
}

function editItemsFields(items) {
  return `
    <div class="edit-item-list">
      <span class="item-meta">Productos del registro</span>
      ${items.map((item, index) => `
        <div class="edit-item-row" data-edit-item>
          <label>Producto
            <select data-edit-item-product>
              ${activeProducts().map((product) => `<option value="${product.id}" ${product.id === item.productId ? "selected" : ""}>${product.name}</option>`).join("")}
            </select>
          </label>
          <label>Cantidad
            <input data-edit-item-quantity type="number" min="1" step="1" value="${Number(item.quantity) || 1}" required>
          </label>
          <label>Precio unitario
            <input data-edit-item-price type="number" min="0" step="1" value="${Number(item.unitPrice) || 0}" required>
          </label>
        </div>
      `).join("")}
    </div>
  `;
}

function editSalePaymentFields(sale) {
  const breakdown = salePaymentBreakdown(sale);
  return `
    <div class="edit-payment-list">
      <span class="item-meta">Montos por método de pago</span>
      <div class="edit-payment-grid">
        <label>Efectivo
          <input data-edit-payment="efectivo" type="number" min="0" step="1" value="${breakdown.efectivo || 0}">
        </label>
        <label>Tarjeta
          <input data-edit-payment="tarjeta" type="number" min="0" step="1" value="${breakdown.tarjeta || 0}">
        </label>
        <label>Pendiente
          <input data-edit-payment="pendiente" type="number" min="0" step="1" value="${breakdown.pendiente || 0}">
        </label>
      </div>
      <span class="item-meta">Los montos deben sumar el total actualizado de la venta.</span>
    </div>
  `;
}

function collectEditItems() {
  return $$("#editFields [data-edit-item]")
    .map((row) => ({
      productId: row.querySelector("[data-edit-item-product]").value,
      quantity: Number(row.querySelector("[data-edit-item-quantity]").value) || 0,
      unitPrice: Number(row.querySelector("[data-edit-item-price]").value) || 0
    }))
    .filter((item) => item.productId && item.quantity > 0);
}

function collectEditSalePaymentBreakdown(total) {
  const breakdown = emptySalePaymentBreakdown();
  $$("#editFields [data-edit-payment]").forEach((input) => {
    breakdown[input.dataset.editPayment] = Number(input.value) || 0;
  });
  const sum = Object.values(breakdown).reduce((totalAmount, amount) => totalAmount + amount, 0);
  if (sum !== total) {
    return { error: `Los pagos deben sumar ${money(total)}. Ahora suman ${money(sum)}` };
  }
  return { breakdown };
}

function openEdit(type, id) {
  pendingEdit = { type, id };
  const fields = $("#editFields");
  const title = $("#editTitle");
  if (type === "sales") {
    const sale = state.sales.find((row) => row.id === id);
    title.textContent = "Modificar venta";
    fields.innerHTML = [
      editField("Fecha", "editDate", "date", todayInputValueFromIso(sale.createdAt), "required"),
      editItemsFields(saleItems(sale)),
      editSalePaymentFields(sale),
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
  if (type === "reservations") {
    const reservation = state.reservations.find((row) => row.id === id);
    title.textContent = "Modificar reserva";
    fields.innerHTML = [
      editSelect("Cliente", "editCustomerId", activeCustomers(), reservation.customerId, (row) => customerName(row.id)),
      editField("Fecha reserva", "editDate", "date", todayInputValueFromIso(reservation.createdAt), "required"),
      editItemsFields(reservationItems(reservation)),
      `<label>Pago al entregar<select id="editPaymentStatus">
        <option value="efectivo" ${reservation.paymentStatus === "efectivo" ? "selected" : ""}>Efectivo</option>
        <option value="tarjeta" ${reservation.paymentStatus === "tarjeta" ? "selected" : ""}>Tarjeta</option>
        <option value="pendiente" ${reservation.paymentStatus === "pendiente" ? "selected" : ""}>Pendiente</option>
      </select></label>`,
      editField("Nota", "editNote", "text", reservation.note || "")
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
    const items = collectEditItems();
    if (!items.length) {
      toast("Agrega al menos un producto");
      return;
    }
    const total = itemsTotal(items);
    const payment = collectEditSalePaymentBreakdown(total);
    if (payment.error) {
      toast(payment.error);
      return;
    }
    await put("sales", {
      ...sale,
      items,
      productId: primaryProductId(items),
      createdAt: dateKeepingTime(sale.createdAt, $("#editDate").value),
      quantity: itemsQuantity(items),
      unitPrice: averageUnitPrice(items),
      paymentStatus: paymentStatusFromBreakdown(payment.breakdown),
      paymentBreakdown: payment.breakdown,
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
  if (type === "reservations") {
    const reservation = state.reservations.find((row) => row.id === id);
    const items = collectEditItems();
    if (!items.length) {
      toast("Agrega al menos un producto");
      return;
    }
    const stockIssue = stockAvailabilityIssue(items, id);
    if (stockIssue) {
      toast(stockIssue);
      return;
    }
    await put("reservations", {
      ...reservation,
      items,
      productId: primaryProductId(items),
      customerId: $("#editCustomerId").value,
      createdAt: dateKeepingTime(reservation.createdAt, $("#editDate").value),
      quantity: itemsQuantity(items),
      unitPrice: averageUnitPrice(items),
      paymentStatus: $("#editPaymentStatus").value,
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
    customers: state.customers,
    reservations: state.reservations,
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
  for (const customer of payload.customers || []) await put("customers", customer);
  for (const reservation of payload.reservations || []) await put("reservations", reservation);
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
  $("#dailyPaymentDate").addEventListener("change", renderDailyPaymentSummary);
  $("#saleQty").addEventListener("input", updateSalePreview);
  $("#saleQtyMinus").addEventListener("click", () => adjustQuantity("#saleQty", -1, updateSalePreview));
  $("#saleQtyPlus").addEventListener("click", () => adjustQuantity("#saleQty", 1, updateSalePreview));
  $("#saleProduct").addEventListener("change", () => {
    state.settings.lastSaleProductId = $("#saleProduct").value;
    saveSettings();
    updateSalePreview();
  });
  $("#salePrice").addEventListener("input", () => {
    const rawPrice = $("#salePrice").value;
    const price = Number(rawPrice);
    if (rawPrice !== "" && !Number.isNaN(price) && price >= 0) state.settings.lastSalePrice = price;
    saveSettings();
    updateSalePreview();
    renderPriceButtons();
  });
  $$("input[name='salePaymentMethods']").forEach((input) => input.addEventListener("change", syncSalePaymentSplit));
  ["#salePaymentCash", "#salePaymentCard", "#salePaymentPending"].forEach((selector) => {
    $(selector).addEventListener("input", syncSalePaymentSplit);
  });
  $("#reservationQty").addEventListener("input", updateReservationPreview);
  $("#reservationQtyMinus").addEventListener("click", () => adjustQuantity("#reservationQty", -1, updateReservationPreview));
  $("#reservationQtyPlus").addEventListener("click", () => adjustQuantity("#reservationQty", 1, updateReservationPreview));
  $("#reservationProduct").addEventListener("change", () => {
    state.settings.lastReservationProductId = $("#reservationProduct").value;
    saveSettings();
    updateReservationPreview();
  });
  $("#reservationPrice").addEventListener("input", () => {
    const rawPrice = $("#reservationPrice").value;
    const price = Number(rawPrice);
    if (rawPrice !== "" && !Number.isNaN(price) && price >= 0) state.settings.lastSalePrice = price;
    saveSettings();
    updateReservationPreview();
    renderPriceButtons();
  });
  $("#addSaleItemBtn").addEventListener("click", addCurrentSaleItemToDraft);
  $("#addReservationItemBtn").addEventListener("click", addCurrentReservationItemToDraft);
  $("#newCustomerPhone").addEventListener("input", () => {
    $("#newCustomerPhone").value = chileMobileLocalDigits($("#newCustomerPhone").value);
  });
  $("#reservationCustomerSearch").addEventListener("input", renderReservationCustomerSearch);
  $("#reservationBroadcastMessage").addEventListener("input", () => {
    if (whatsappBroadcastPrepared) renderReservationBroadcast();
  });
  $("#prepareReservationWhatsappBtn").addEventListener("click", () => {
    whatsappBroadcastPrepared = true;
    renderReservationBroadcast();
    toast("Mensajes de WhatsApp preparados");
  });
  $("#purchaseQty").addEventListener("input", updatePurchasePreview);
  $("#purchaseQtyMinus").addEventListener("click", () => adjustQuantity("#purchaseQty", -1, updatePurchasePreview));
  $("#purchaseQtyPlus").addEventListener("click", () => adjustQuantity("#purchaseQty", 1, updatePurchasePreview));
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
  $("#addCustomerBtn").addEventListener("click", async () => {
    const customer = await addCustomer($("#newCustomerFirstName").value, $("#newCustomerLastName").value, $("#newCustomerPhone").value);
    if (!customer) {
      toast("Agrega nombre y apellido del cliente");
      return;
    }
    $("#newCustomerFirstName").value = "";
    $("#newCustomerLastName").value = "";
    $("#newCustomerPhone").value = "";
    renderSelectors();
    $("#reservationCustomer").value = customer.id;
    toast("Cliente agregado");
  });
  $("#saleForm").addEventListener("submit", saveSale);
  $("#reservationForm").addEventListener("submit", saveReservation);
  $("#purchaseForm").addEventListener("submit", savePurchase);
  $("#paymentForm").addEventListener("submit", savePayment);
  $("#editForm").addEventListener("submit", saveEdit);
  $("#cancelEditBtn").addEventListener("click", () => $("#editDialog").close());
  $("#pinForm").addEventListener("submit", confirmDelete);
  $("#cancelPinBtn").addEventListener("click", () => $("#pinDialog").close());
}

async function saveSale(event) {
  event.preventDefault();
  const items = draftItemsForSubmit(saleDraftItems, readFormItem("#saleProduct", "#saleQty", "#salePrice"));
  if (!items.length) {
    toast("Agrega al menos un producto a la venta");
    return;
  }
  const stockIssue = stockAvailabilityIssue(items);
  if (stockIssue) {
    toast(stockIssue);
    return;
  }
  const total = itemsTotal(items);
  const payment = readSalePaymentBreakdown(total);
  if (payment.error) {
    toast(payment.error);
    return;
  }
  const sale = {
    id: uid("sale"),
    productId: primaryProductId(items),
    createdAt: inputDateToIso($("#saleDate").value),
    quantity: itemsQuantity(items),
    unitPrice: averageUnitPrice(items),
    items,
    paymentStatus: paymentStatusFromBreakdown(payment.breakdown),
    paymentBreakdown: payment.breakdown,
    note: $("#saleNote").value.trim()
  };
  await put("sales", sale);
  const lastPrice = items[items.length - 1]?.unitPrice ?? sale.unitPrice;
  state.settings.lastSaleProductId = items[items.length - 1]?.productId || sale.productId;
  state.settings.lastSalePrice = lastPrice;
  if (!state.settings.salePricePresets.includes(lastPrice)) {
    state.settings.salePricePresets.push(lastPrice);
  }
  await saveSettings();
  saleDraftItems = [];
  $("#saleQty").value = "";
  $("#saleNote").value = "";
  ["#salePaymentCash", "#salePaymentCard", "#salePaymentPending"].forEach((selector) => {
    $(selector).value = "";
  });
  await loadState();
  renderAll();
  if (state.settings.lastSaleProductId) {
    $("#saleProduct").value = state.settings.lastSaleProductId;
  }
  updateSalePreview();
  toast("Venta guardada");
}

async function saveReservation(event) {
  event.preventDefault();
  if (!$("#reservationCustomer").value) {
    toast("Crea o selecciona un cliente");
    return;
  }
  const items = draftItemsForSubmit(reservationDraftItems, readFormItem("#reservationProduct", "#reservationQty", "#reservationPrice"));
  if (!items.length) {
    toast("Agrega al menos un producto a la reserva");
    return;
  }
  const stockIssue = stockAvailabilityIssue(items);
  if (stockIssue) {
    toast(stockIssue);
    return;
  }
  const reservation = {
    id: uid("reservation"),
    productId: primaryProductId(items),
    customerId: $("#reservationCustomer").value,
    createdAt: inputDateToIso($("#reservationDate").value),
    quantity: itemsQuantity(items),
    unitPrice: averageUnitPrice(items),
    items,
    paymentStatus: activeRadioValue("reservationPaymentStatus"),
    status: "pendiente",
    note: $("#reservationNote").value.trim()
  };
  await put("reservations", reservation);
  const lastPrice = items[items.length - 1]?.unitPrice ?? reservation.unitPrice;
  state.settings.lastReservationProductId = items[items.length - 1]?.productId || reservation.productId;
  state.settings.lastSalePrice = lastPrice;
  if (!state.settings.salePricePresets.includes(lastPrice)) {
    state.settings.salePricePresets.push(lastPrice);
  }
  await saveSettings();
  reservationDraftItems = [];
  $("#reservationQty").value = "";
  $("#reservationNote").value = "";
  await loadState();
  renderAll();
  if (state.settings.lastReservationProductId) {
    $("#reservationProduct").value = state.settings.lastReservationProductId;
  }
  updateReservationPreview();
  toast("Reserva guardada");
}

async function deliverReservation(id) {
  const reservation = state.reservations.find((row) => row.id === id);
  if (!reservation || reservation.status === "entregado") return;
  const items = reservationItems(reservation);
  if (!items.length) {
    toast("La reserva no tiene productos");
    return;
  }
  const stockRows = stockByProduct();
  for (const item of items) {
    const stockRow = stockRows.find((row) => row.product.id === item.productId);
    const available = stockRow?.stock || 0;
    if (available < item.quantity) {
      toast(`Stock insuficiente en ${productName(item.productId)}: quedan ${units(available)}`);
      return;
    }
  }
  const now = new Date().toISOString();
  const customer = state.customers.find((row) => row.id === reservation.customerId);
  const customerLabel = `${customerName(reservation.customerId)}${customer?.phone ? ` · ${customer.phone}` : ""}`;
  const sale = {
    id: uid("sale"),
    productId: primaryProductId(items),
    createdAt: now,
    quantity: itemsQuantity(items),
    unitPrice: averageUnitPrice(items),
    items,
    paymentStatus: reservation.paymentStatus || "efectivo",
    note: `Reserva entregada · ${customerLabel}${reservation.note ? ` · ${reservation.note}` : ""}`,
    reservationId: reservation.id
  };
  await put("sales", sale);
  await put("reservations", {
    ...reservation,
    status: "entregado",
    deliveredAt: now,
    saleId: sale.id,
    updatedAt: now
  });
  await loadState();
  renderAll();
  toast("Reserva entregada y venta creada");
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

function disableDoubleTapZoom() {
  const resetHorizontalScroll = () => {
    if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
    if (document.documentElement.scrollLeft) document.documentElement.scrollLeft = 0;
    if (document.body.scrollLeft) document.body.scrollLeft = 0;
  };
  document.addEventListener("touchstart", (event) => {
    const touch = event.touches?.[0];
    if (!touch) return;
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchHorizontalLocked = false;
    resetHorizontalScroll();
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    const touch = event.touches?.[0];
    if (!touch) return;
    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;
    const horizontalDistance = Math.abs(deltaX);
    const verticalDistance = Math.abs(deltaY);
    if (horizontalDistance > 8 && horizontalDistance > verticalDistance * 0.35) {
      touchHorizontalLocked = true;
    }
    if (touchHorizontalLocked) {
      event.preventDefault();
    }
    resetHorizontalScroll();
  }, { passive: false });
  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (touchHorizontalLocked || now - lastTouchEnd <= 320) {
      event.preventDefault();
    }
    lastTouchEnd = now;
    touchHorizontalLocked = false;
    resetHorizontalScroll();
  }, { passive: false });
  window.addEventListener("scroll", resetHorizontalScroll, { passive: true });
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
}

async function init() {
  db = await openDb();
  await loadState();
  disableDoubleTapZoom();
  bindEvents();
  renderAll();
  updateClock();
  setInterval(updateClock, 30000);
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });
    navigator.serviceWorker.register(`./sw.js?v=${APP_VERSION}`).then((registration) => {
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            toast("Actualizando app...");
            setTimeout(() => window.location.reload(), 500);
          }
        });
      });
    }).catch(() => {});
  }
}

init().catch((error) => {
  console.error(error);
  toast("No se pudo iniciar la app");
});
