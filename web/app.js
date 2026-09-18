"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const PREVIEW_MIN_WIDTH = 280;
const PREVIEW_MAX_WIDTH = 620;
const clampPreviewWidth = (value) => Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, Number(value) || 390));
function storedPreviewWidth() {
  try { return clampPreviewWidth(localStorage.getItem("pss-preview-width")); } catch (_) { return 390; }
}

const defaultLayout = Object.freeze({
  mode: "grid",
  paper: "a4",
  orientation: "portrait",
  across: 1,
  flow: "rows",
  margin: 10,
  gap: 3,
  slipHeight: 42,
  accent: "#185adb",
  ink: "#151719",
  paperColor: "#ffffff",
  borderColor: "#c9ced4",
  labelSize: 8,
  valueSize: 12,
  font: "Helvetica",
  labelCase: "upper",
  fieldColumns: 0,
  labelPosition: "preset",
  valueAlign: "left",
  labelWidth: 36,
  padding: 2,
  radius: 0,
  showBorder: true,
  cutMarks: true,
  footer: true,
  fieldLines: true,
  zebra: false,
  showBlankFields: false,
  headerText: "",
  subtitle: "",
  footerText: "",
  headerStyle: "line",
  logoData: "",
});

const rowPresetKeys = [
  "mode", "accent", "ink", "paperColor", "borderColor", "labelSize", "valueSize", "font", "labelCase",
  "fieldColumns", "labelPosition", "valueAlign", "labelWidth", "padding", "radius", "showBorder", "fieldLines",
  "zebra", "headerText", "subtitle", "footerText", "headerStyle", "logoData",
];

function safeLogoData(value) {
  const text = String(value || "");
  return /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/i.test(text) ? text : "";
}

function starterDocument() {
  const columns = [
    { id: "name", label: "Name", group: "", type: "text", style: "strong", visibility: "always", width: 1.3, required: true },
    { id: "username", label: "Username", group: "", type: "text", style: "standard", visibility: "always", width: 1, required: true, unique: true },
    { id: "password", label: "Password", group: "", type: "password", style: "mono", visibility: "always", width: 1.1, required: true },
    { id: "recovery", label: "Recovery code", group: "", type: "password", style: "mono", visibility: "nonempty", width: 1.1, required: false },
  ];
  return {
    version: 1,
    name: "Untitled password slips",
    columns,
    rows: [],
    rules: [{
      id: uid("rule"),
      name: "Show recovery code when present",
      enabled: true,
      action: "show_field",
      target: "recovery",
      match: "all",
      conditions: [{ field: "recovery", operator: "not_empty", value: "" }],
    }],
    views: [],
    presets: [],
    layout: clone(defaultLayout),
  };
}

const ui = {
  view: "data",
  selectedRows: new Set(),
  selectedPreviewRow: null,
  search: "",
  history: [],
  future: [],
  zoom: 0.78,
  previewPage: 0,
  dataPage: 0,
  pageSize: 50,
  importData: null,
  rowOptionsId: null,
  activeDataViewId: "",
  ruleTestRowId: "",
  commandIndex: 0,
  sortColumn: "",
  sortDirection: "asc",
  saveTimer: null,
  dirty: false,
  previewWidth: storedPreviewWidth(),
};

function loadDocument() {
  try {
    const saved = JSON.parse(localStorage.getItem("password-slip-studio-document"));
    if (saved && Array.isArray(saved.columns) && Array.isArray(saved.rows)) {
      const legacyNames = ["Ava Chen", "Noah Williams", "Mia Patel", "Leo Martin", "Zoe Taylor", "Eli Brown"];
      const isLegacySample = saved.rows.length === legacyNames.length && saved.rows.every((row, index) => row?.values?.name === legacyNames[index]);
      if (!isLegacySample) {
        if (!saved.rows.length && saved.name === "Term 3 password slips") saved.name = "Untitled password slips";
        return normaliseDocument(saved);
      }
      localStorage.removeItem("password-slip-studio-document");
    }
  } catch (_) {}
  return starterDocument();
}

function normaliseDocument(input) {
  const document = clone(input);
  document.version = 1;
  document.name = String(document.name || "Untitled password slips");
  document.columns = Array.isArray(document.columns) ? document.columns : [];
  document.rows = Array.isArray(document.rows) ? document.rows : [];
  document.rules = Array.isArray(document.rules) ? document.rules : [];
  document.views = Array.isArray(document.views) ? document.views.filter((view) => view && typeof view === "object").map((view) => ({
    id: String(view.id || uid("view")),
    name: String(view.name || "Saved view"),
    search: String(view.search || ""),
    sortColumn: String(view.sortColumn || ""),
    sortDirection: view.sortDirection === "desc" ? "desc" : "asc",
  })) : [];
  document.presets = Array.isArray(document.presets) ? document.presets.filter((preset) => preset && typeof preset === "object" && preset.layout && typeof preset.layout === "object").map((preset) => ({ id: String(preset.id || uid("preset")), name: String(preset.name || "Saved layout"), layout: { ...defaultLayout, ...clone(preset.layout) } })) : [];
  document.layout = { ...defaultLayout, ...(document.layout || {}) };
  document.layout.logoData = safeLogoData(document.layout.logoData);
  document.presets.forEach((preset) => { preset.layout.logoData = safeLogoData(preset.layout.logoData); });
  document.columns.forEach((column, index) => {
    column.id = String(column.id || uniqueColumnId(`column_${index + 1}`, document.columns));
    column.label = String(column.label || `Column ${index + 1}`);
    column.group = String(column.group || "").trim();
    column.type = ["text", "password", "number", "date", "url"].includes(column.type) ? column.type : "text";
    column.style ||= column.type === "password" ? "mono" : "standard";
    column.valueTransform = ["as_entered", "upper", "lower", "title", "mask_last4"].includes(column.valueTransform) ? column.valueTransform : "as_entered";
    column.valueAlign = ["default", "left", "center", "right"].includes(column.valueAlign) ? column.valueAlign : "default";
    column.visibility ||= "always";
    column.width = Number(column.width) || 1;
    column.required = Boolean(column.required);
    column.unique = Boolean(column.unique);
  });
  document.rows.forEach((row) => {
    row.id ||= uid("row");
    row.values = row.values && typeof row.values === "object" ? row.values : {};
    row.overrides = row.overrides && typeof row.overrides === "object" ? row.overrides : {};
    row.layoutOverride = row.layoutOverride && typeof row.layoutOverride === "object" ? row.layoutOverride : {};
    if (Object.prototype.hasOwnProperty.call(row.layoutOverride, "logoData")) row.layoutOverride.logoData = safeLogoData(row.layoutOverride.logoData);
    row.disabled = Boolean(row.disabled);
  });
  return document;
}

let documentState = loadDocument();

function snapshot() { return JSON.stringify(documentState); }

function pushHistory() {
  ui.history.push(snapshot());
  if (ui.history.length > 60) ui.history.shift();
  ui.future = [];
}

function commit(mutator, { render = true } = {}) {
  pushHistory();
  mutator(documentState);
  changed();
  if (render) renderAll();
}

function changed() {
  ui.dirty = true;
  $("#saveStatus").textContent = "Saving…";
  clearTimeout(ui.saveTimer);
  ui.saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("password-slip-studio-document", snapshot());
      ui.dirty = false;
      $("#saveStatus").textContent = "Saved locally";
    } catch (_) {
      $("#saveStatus").textContent = "Storage unavailable";
    }
  }, 220);
}

function restore(serialised) {
  documentState = normaliseDocument(JSON.parse(serialised));
  ui.selectedRows.clear();
  renderAll();
  changed();
}

function undo() {
  if (!ui.history.length) return;
  ui.future.push(snapshot());
  restore(ui.history.pop());
}

function redo() {
  if (!ui.future.length) return;
  ui.history.push(snapshot());
  restore(ui.future.pop());
}

function showView(view) {
  ui.view = view;
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `${view}View`));
  if (view === "data") requestAnimationFrame(() => $("#rowSearch").focus());
}

function rowValuesText(row) {
  return documentState.columns.map((column) => row.values[column.id] ?? "").join(" ").toLowerCase();
}

function formatValue(value, column) {
  const text = String(value ?? "");
  switch (column.valueTransform) {
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "title": return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
    case "mask_last4": return text.length > 4 ? `${"•".repeat(Math.max(4, text.length - 4))}${text.slice(-4)}` : text;
    default: return text;
  }
}

function missingRequiredColumns(row) {
  return documentState.columns.filter((column) => column.required && !String(row.values?.[column.id] ?? "").trim());
}

function valueValidationIssue(row, column) {
  const value = String(row.values?.[column.id] ?? "").trim();
  if (!value) return "";
  if (column.type === "number" && !Number.isFinite(Number(value))) return "Enter a number";
  if (column.type === "date" && Number.isNaN(Date.parse(value))) return "Enter a valid date";
  if (column.type === "url") {
    try {
      const candidate = /:\/\//.test(value) ? value : `https://${value}`;
      if (!new URL(candidate).hostname) return "Enter a valid URL";
    } catch (_) {
      return "Enter a valid URL";
    }
  }
  return "";
}

function inputTypeForColumn(column) {
  if (column.type === "number") return "number";
  if (column.type === "url") return "url";
  return "text";
}

function duplicateValueCounts(rows = documentState.rows, columns = documentState.columns) {
  const result = new Map();
  columns.filter((column) => column.unique).forEach((column) => {
    const counts = new Map();
    rows.forEach((row) => {
      const value = String(row.values?.[column.id] ?? "").trim().toLowerCase();
      if (value) counts.set(value, (counts.get(value) || 0) + 1);
    });
    result.set(column.id, counts);
  });
  return result;
}

function hasDuplicateValue(row, column, counts = duplicateValueCounts()) {
  if (!column.unique) return false;
  const value = String(row.values?.[column.id] ?? "").trim().toLowerCase();
  return Boolean(value) && (counts.get(column.id)?.get(value) || 0) > 1;
}

function filteredRows() {
  if (ui.sortColumn && !documentState.columns.some((column) => column.id === ui.sortColumn)) ui.sortColumn = "";
  const query = ui.search.trim().toLowerCase();
  const rows = documentState.rows.filter((row) => !query || rowValuesText(row).includes(query));
  if (!ui.sortColumn) return rows;
  return rows.slice().sort((left, right) => {
    const a = String(left.values?.[ui.sortColumn] ?? "").trim();
    const b = String(right.values?.[ui.sortColumn] ?? "").trim();
    const numeric = a !== "" && b !== "" && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b));
    const comparison = numeric ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
    return ui.sortDirection === "desc" ? -comparison : comparison;
  });
}

function currentDataViewState() {
  return { search: ui.search, sortColumn: ui.sortColumn, sortDirection: ui.sortDirection === "desc" ? "desc" : "asc" };
}

function matchingDataView() {
  const current = currentDataViewState();
  return (documentState.views || []).find((view) => view.search === current.search && view.sortColumn === current.sortColumn && view.sortDirection === current.sortDirection) || null;
}

function renderDataViews() {
  const select = $("#savedViewSelect");
  if (!select) return;
  const matching = matchingDataView();
  if (matching) ui.activeDataViewId = matching.id;
  else ui.activeDataViewId = "";
  select.innerHTML = `<option value="">Ad hoc view</option>${(documentState.views || []).map((view) => `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name)}</option>`).join("")}`;
  select.value = ui.activeDataViewId;
  $("#deleteDataViewButton").disabled = !ui.activeDataViewId;
}

function applyDataView(viewId) {
  const view = (documentState.views || []).find((item) => item.id === viewId);
  if (!view) {
    ui.activeDataViewId = "";
    ui.search = "";
    ui.sortColumn = "";
    ui.sortDirection = "asc";
    ui.dataPage = 0;
  } else {
    ui.activeDataViewId = view.id;
    ui.search = view.search;
    ui.sortColumn = documentState.columns.some((column) => column.id === view.sortColumn) ? view.sortColumn : "";
    ui.sortDirection = view.sortDirection === "desc" ? "desc" : "asc";
    ui.dataPage = 0;
  }
  $("#rowSearch").value = ui.search;
  renderData();
}

function suggestedDataViewName() {
  const current = currentDataViewState();
  const existing = matchingDataView();
  return existing?.name || (current.search ? `Filter: ${current.search}` : current.sortColumn ? `Sorted by ${documentState.columns.find((column) => column.id === current.sortColumn)?.label || "field"}` : "New data view");
}

function saveDataView() {
  $("#saveDataViewName").value = suggestedDataViewName();
  $("#saveViewDialog").showModal();
  requestAnimationFrame(() => { $("#saveDataViewName").focus(); $("#saveDataViewName").select(); });
}

function commitDataView(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) { toast("Give this view a name first", "error"); $("#saveDataViewName").focus(); return; }
  const current = currentDataViewState();
  const existing = matchingDataView();
  let finalName = trimmed;
  commit((state) => {
    const duplicateName = state.views.find((view) => view.name.toLowerCase() === name.toLowerCase() && view.id !== existing?.id);
    const target = existing || { id: uid("view"), name: trimmed, ...current };
    if (duplicateName) finalName = `${trimmed} copy`;
    target.name = finalName;
    target.search = current.search;
    target.sortColumn = current.sortColumn;
    target.sortDirection = current.sortDirection;
    if (!existing) state.views.push(target);
    ui.activeDataViewId = target.id;
  });
  $("#saveViewDialog").close();
  toast(`Saved view “${finalName}”`);
}

async function deleteDataView() {
  const view = (documentState.views || []).find((item) => item.id === ui.activeDataViewId);
  if (!view) return;
  if (!await confirmAction("Delete saved view?", `“${view.name}” will be removed. The current filter and sort will stay in place.`, "Delete")) return;
  commit((state) => { state.views = state.views.filter((item) => item.id !== view.id); });
  ui.activeDataViewId = "";
  renderData();
  toast("Saved view removed");
}

function conditionMatches(condition, values) {
  const actual = String(values[condition.field] ?? "");
  const expected = String(condition.value ?? "");
  const left = actual.toLowerCase();
  const right = expected.toLowerCase();
  switch (condition.operator) {
    case "not_empty": return Boolean(actual.trim());
    case "empty": return !actual.trim();
    case "equals": return left === right;
    case "not_equals": return left !== right;
    case "contains": return left.includes(right);
    case "not_contains": return !left.includes(right);
    case "starts_with": return left.startsWith(right);
    case "ends_with": return left.endsWith(right);
    case "greater_than": return Number(actual) > Number(expected);
    case "less_than": return Number(actual) < Number(expected);
    case "matches": try { return new RegExp(expected, "i").test(actual); } catch (_) { return false; }
    default: return false;
  }
}

function ruleMatches(rule, values) {
  if (!Array.isArray(rule.conditions) || !rule.conditions.length) return false;
  const results = rule.conditions.map((condition) => conditionMatches(condition, values));
  const matched = rule.match === "any" ? results.some(Boolean) : results.every(Boolean);
  return rule.negate ? !matched : matched;
}

function includedRows() {
  const rules = documentState.rules.filter((rule) => rule.enabled !== false);
  const includeRules = rules.filter((rule) => rule.action === "include_row");
  const excludeRules = rules.filter((rule) => rule.action === "exclude_row");
  return documentState.rows.filter((row) => {
    if (row.disabled) return false;
    if (excludeRules.some((rule) => ruleMatches(rule, row.values))) return false;
    return !includeRules.length || includeRules.some((rule) => ruleMatches(rule, row.values));
  });
}

function visibleColumns(row) {
  const rules = documentState.rules.filter((rule) => rule.enabled !== false);
  const visible = documentState.columns.filter((column) => {
    let shown = column.visibility === "always" || (column.visibility === "nonempty" && (documentState.layout.showBlankFields || Boolean(String(row.values[column.id] ?? "").trim())));
    rules.forEach((rule) => {
      if (rule.target !== column.id || !ruleMatches(rule, row.values)) return;
      if (rule.action === "show_field") shown = true;
      if (rule.action === "hide_field") shown = false;
    });
    if (row.overrides?.[column.id] === true) shown = true;
    if (row.overrides?.[column.id] === false) shown = false;
    return shown;
  });
  return sortColumnsForRow(visible, row);
}

function sortColumnsForRow(columns, row) {
  const order = Array.isArray(row.layoutOverride?.columnOrder) ? row.layoutOverride.columnOrder : [];
  if (!order.length) return columns;
  const explicit = new Map(order.map((id, index) => [id, index]));
  const global = new Map(documentState.columns.map((column, index) => [column.id, index]));
  return columns.slice().sort((left, right) => {
    const leftRank = explicit.has(left.id) ? explicit.get(left.id) : order.length + global.get(left.id);
    const rightRank = explicit.has(right.id) ? explicit.get(right.id) : order.length + global.get(right.id);
    return leftRank - rightRank;
  });
}

function renderAll() {
  $("#documentName").value = documentState.name;
  renderData();
  renderColumns();
  renderRules();
  renderLayout();
  renderPreview();
  $("#columnCount").textContent = documentState.columns.length;
  $("#ruleCount").textContent = documentState.rules.length;
  $("#undoButton").disabled = !ui.history.length;
  $("#redoButton").disabled = !ui.future.length;
}

function renderData() {
  const allRows = filteredRows();
  const pageCount = Math.max(1, Math.ceil(allRows.length / ui.pageSize));
  ui.dataPage = Math.min(ui.dataPage, pageCount - 1);
  const rows = allRows.slice(ui.dataPage * ui.pageSize, (ui.dataPage + 1) * ui.pageSize);
  const duplicateCounts = duplicateValueCounts();
  const previousSort = ui.sortColumn;
  renderDataViews();
  $("#rowSearch").value = ui.search;
  $("#sortColumn").innerHTML = `<option value="">Original order</option>${documentState.columns.map((column) => `<option value="${escapeHtml(column.id)}">${escapeHtml(column.label)}</option>`).join("")}`;
  $("#sortColumn").value = documentState.columns.some((column) => column.id === previousSort) ? previousSort : "";
  $("#sortDirection").value = ui.sortDirection;
  $("#dataSummary").textContent = `${documentState.rows.length} row${documentState.rows.length === 1 ? "" : "s"} · ${documentState.columns.length} column${documentState.columns.length === 1 ? "" : "s"}`;
  $("#dataHead").innerHTML = `<tr><th><input id="selectAllRows" type="checkbox" aria-label="Select all filtered rows" ${allRows.length && allRows.every((row) => ui.selectedRows.has(row.id)) ? "checked" : ""}></th><th class="row-number-head">#</th>${documentState.columns.map((column) => `<th style="width:${Math.max(115, column.width * 130)}px">${escapeHtml(column.label)}</th>`).join("")}<th class="row-menu-head"></th></tr>`;
  $("#dataBody").innerHTML = rows.map((row) => {
    const originalIndex = documentState.rows.indexOf(row) + 1;
    const customized = Object.keys(row.layoutOverride || {}).length > 0 || Object.keys(row.overrides || {}).length > 0;
    return `<tr data-row-id="${row.id}" class="${ui.selectedRows.has(row.id) ? "selected" : ""} ${row.disabled ? "excluded" : ""} ${customized ? "customized" : ""}">
      <td class="select-cell"><input class="row-select" type="checkbox" ${ui.selectedRows.has(row.id) ? "checked" : ""} aria-label="Select row ${originalIndex}"></td>
      <td class="row-number" draggable="true" title="${customized ? "Individual slip customization set · drag to reorder" : "Drag to reorder"}">⠿ ${originalIndex}${customized ? " ✦" : ""}</td>
      ${documentState.columns.map((column) => { const missing = column.required && !String(row.values?.[column.id] ?? "").trim(); const duplicate = hasDuplicateValue(row, column, duplicateCounts); const issue = valueValidationIssue(row, column); const stateClass = [missing ? "missing-required" : "", duplicate ? "duplicate-value" : "", issue ? "invalid-value" : ""].filter(Boolean).join(" "); const invalid = missing || issue; return `<td class="${stateClass}"${issue ? ` title="${escapeHtml(issue)}"` : ""}><input type="${inputTypeForColumn(column)}" class="cell-input ${column.style === "mono" || column.type === "password" ? "password-cell" : ""}" data-column-id="${column.id}" value="${escapeHtml(row.values[column.id] || "")}" aria-label="${escapeHtml(column.label)}, row ${originalIndex}" ${invalid ? "aria-invalid=\"true\"" : ""} ${duplicate ? "data-duplicate=\"true\"" : ""}></td>`; }).join("")}
      <td class="row-menu"><button class="row-menu-button" data-action="row-options" title="Row options" aria-label="Row ${originalIndex} options">•••</button></td>
    </tr>`;
  }).join("");
  $("#dataEmpty").hidden = Boolean(allRows.length);
  const incomplete = documentState.rows.filter((row) => missingRequiredColumns(row).length).length;
  const duplicates = documentState.rows.filter((row) => documentState.columns.some((column) => hasDuplicateValue(row, column, duplicateCounts))).length;
  const invalid = documentState.rows.filter((row) => documentState.columns.some((column) => valueValidationIssue(row, column))).length;
  const rowText = ui.search ? `${allRows.length} of ${documentState.rows.length} rows` : `${documentState.rows.length} rows`;
  const warnings = [incomplete ? `${incomplete} incomplete` : "", duplicates ? `${duplicates} with duplicates` : "", invalid ? `${invalid} invalid` : ""].filter(Boolean);
  $("#visibleRowCount").textContent = warnings.length ? `${rowText} · ${warnings.join(" · ")}` : rowText;
  $("#visibleRowCount").classList.toggle("warning-text", warnings.length > 0);
  $("#pageSizeInput").value = String(ui.pageSize);
  $("#dataPageLabel").textContent = allRows.length ? `Page ${ui.dataPage + 1} / ${pageCount}` : "No pages";
  $("#dataPrevButton").disabled = !allRows.length || ui.dataPage <= 0;
  $("#dataNextButton").disabled = !allRows.length || ui.dataPage >= pageCount - 1;
  renderSelectionToolbar();
}

function renderSelectionToolbar() {
  const count = [...ui.selectedRows].filter((id) => documentState.rows.some((row) => row.id === id)).length;
  $("#selectionToolbar").hidden = count === 0;
  $("#selectionCount").textContent = `${count} selected`;
  const bulkEditButton = $("#bulkEditButton");
  if (bulkEditButton) bulkEditButton.disabled = count === 0;
  const customizeButton = $("#customizeSelectedButton");
  if (customizeButton) customizeButton.disabled = count === 0;
  const resetButton = $("#resetSelectedLayoutsButton");
  if (resetButton) resetButton.disabled = count === 0;
  const copyButton = $("#applyRowLayoutToSelectionButton");
  if (copyButton) {
    copyButton.disabled = count === 0;
    copyButton.textContent = count ? `Copy this customization to ${count} selected` : "Select rows to copy this customization";
  }
}

function openSelectedRowOptions() {
  const row = documentState.rows.find((item) => ui.selectedRows.has(item.id));
  if (!row) { toast("Select at least one row first", "error"); return; }
  openRowOptions(row.id);
}

function selectedRows() {
  return documentState.rows.filter((row) => ui.selectedRows.has(row.id));
}

function bulkEditTransform(value, operation, fields = {}) {
  const text = String(value ?? "");
  switch (operation) {
    case "set": return String(fields.value ?? "");
    case "clear": return "";
    case "replace": return fields.find ? text.split(String(fields.find)).join(String(fields.replacement ?? "")) : text;
    case "prefix": return `${String(fields.text ?? "")}${text}`;
    case "suffix": return `${text}${String(fields.text ?? "")}`;
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "title": return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
    case "trim": return text.trim();
    default: return text;
  }
}

function bulkEditFields() {
  const operation = $("#bulkEditOperation").value;
  if (operation === "set") return `<label>Value<input id="bulkEditValue" type="text" placeholder="Value for every selected row" autocomplete="off"></label>`;
  if (operation === "replace") return `<div class="bulk-edit-inline"><label>Find<input id="bulkEditFind" type="text" placeholder="Text to find" autocomplete="off"></label><label>Replace with<input id="bulkEditReplacement" type="text" placeholder="Replacement text" autocomplete="off"></label></div>`;
  if (operation === "prefix" || operation === "suffix") return `<label>${operation === "prefix" ? "Prefix" : "Suffix"}<input id="bulkEditText" type="text" placeholder="Text to add" autocomplete="off"></label>`;
  return `<span class="bulk-edit-helper">This operation changes the selected column in place.</span>`;
}

function bulkEditFieldValues() {
  return {
    value: $("#bulkEditValue")?.value || "",
    find: $("#bulkEditFind")?.value || "",
    replacement: $("#bulkEditReplacement")?.value || "",
    text: $("#bulkEditText")?.value || "",
  };
}

function updateBulkEditPreview() {
  const rows = selectedRows();
  const column = documentState.columns.find((item) => item.id === $("#bulkEditColumn")?.value);
  const operation = $("#bulkEditOperation")?.value || "set";
  const preview = $("#bulkEditPreview");
  if (!preview) return;
  if (!rows.length) { preview.textContent = "Select at least one row first."; return; }
  if (!column) { preview.textContent = "Choose a column to edit."; return; }
  const fields = bulkEditFieldValues();
  if (operation === "replace" && !fields.find) { preview.textContent = "Enter text to find before applying a replacement."; preview.classList.add("warning"); return; }
  preview.classList.remove("warning");
  const changed = rows.filter((row) => String(row.values?.[column.id] ?? "") !== bulkEditTransform(row.values?.[column.id] ?? "", operation, fields));
  const first = rows.find((row) => changed.includes(row));
  const sample = first ? ` Preview: “${String(first.values?.[column.id] ?? "").slice(0, 32)}” → “${bulkEditTransform(first.values?.[column.id] ?? "", operation, fields).slice(0, 32)}”.` : " No values would change.";
  preview.textContent = `${changed.length} of ${rows.length} selected row${rows.length === 1 ? "" : "s"} will change in “${column.label}”.${sample}`;
}

function renderBulkEditFields() {
  const fields = $("#bulkEditFields");
  if (!fields) return;
  fields.innerHTML = bulkEditFields();
  fields.querySelectorAll("input").forEach((input) => input.addEventListener("input", updateBulkEditPreview));
  updateBulkEditPreview();
}

function openBulkEdit() {
  const rows = selectedRows();
  if (!rows.length) { toast("Select at least one row first", "error"); return; }
  $("#bulkEditSummary").textContent = `${rows.length} selected row${rows.length === 1 ? "" : "s"} · changes can be undone`;
  $("#bulkEditColumn").innerHTML = documentState.columns.map((column) => `<option value="${escapeHtml(column.id)}">${escapeHtml(column.label)}</option>`).join("");
  $("#bulkEditOperation").value = "set";
  renderBulkEditFields();
  $("#bulkEditDialog").showModal();
  requestAnimationFrame(() => $("#bulkEditColumn").focus());
}

function applyBulkEdit() {
  const rows = selectedRows();
  const column = documentState.columns.find((item) => item.id === $("#bulkEditColumn").value);
  const operation = $("#bulkEditOperation").value;
  const fields = bulkEditFieldValues();
  if (!rows.length || !column) { toast("Select rows and a column first", "error"); return; }
  if (operation === "replace" && !fields.find) { toast("Enter text to find before replacing", "error"); return; }
  const changed = rows.filter((row) => String(row.values?.[column.id] ?? "") !== bulkEditTransform(row.values?.[column.id] ?? "", operation, fields));
  if (!changed.length) { $("#bulkEditDialog").close(); toast("No selected values needed changing"); return; }
  const ids = new Set(changed.map((row) => row.id));
  commit((state) => state.rows.forEach((row) => {
    if (ids.has(row.id)) row.values[column.id] = bulkEditTransform(row.values?.[column.id] ?? "", operation, fields);
  }));
  $("#bulkEditDialog").close();
  toast(`Updated ${changed.length} row${changed.length === 1 ? "" : "s"} in “${column.label}”`);
}

function columnOptions(selected) {
  return documentState.columns.map((column) => `<option value="${column.id}" ${column.id === selected ? "selected" : ""}>${escapeHtml(column.label)}</option>`).join("");
}

function renderColumns() {
  $("#columnList").innerHTML = documentState.columns.map((column) => `<article class="column-row" data-column-id="${column.id}" draggable="true">
    <div class="column-field"><button class="drag-handle" title="Drag to reorder" aria-label="Drag ${escapeHtml(column.label)}">⠿</button><div class="column-name-group"><input class="column-label-input" value="${escapeHtml(column.label)}" aria-label="Column label"><input class="column-group-input" value="${escapeHtml(column.group || "")}" aria-label="${escapeHtml(column.label)} group" placeholder="Group (optional)"><span class="column-key">${escapeHtml(column.id)}</span><select class="column-type-input" aria-label="${escapeHtml(column.label)} type"><option value="text" ${column.type === "text" ? "selected" : ""}>Text</option><option value="password" ${column.type === "password" ? "selected" : ""}>Password</option><option value="number" ${column.type === "number" ? "selected" : ""}>Number</option><option value="date" ${column.type === "date" ? "selected" : ""}>Date / time</option><option value="url" ${column.type === "url" ? "selected" : ""}>Link / URL</option></select><select class="column-transform-input" aria-label="${escapeHtml(column.label)} value transform"><option value="as_entered" ${column.valueTransform === "as_entered" ? "selected" : ""}>As entered</option><option value="upper" ${column.valueTransform === "upper" ? "selected" : ""}>UPPERCASE</option><option value="lower" ${column.valueTransform === "lower" ? "selected" : ""}>lowercase</option><option value="title" ${column.valueTransform === "title" ? "selected" : ""}>Title Case</option><option value="mask_last4" ${column.valueTransform === "mask_last4" ? "selected" : ""}>Mask · last 4</option></select><select class="column-align-input" aria-label="${escapeHtml(column.label)} value alignment"><option value="default" ${column.valueAlign === "default" ? "selected" : ""}>Sheet alignment</option><option value="left" ${column.valueAlign === "left" ? "selected" : ""}>Left</option><option value="center" ${column.valueAlign === "center" ? "selected" : ""}>Centre</option><option value="right" ${column.valueAlign === "right" ? "selected" : ""}>Right</option></select></div></div>
    <select class="column-format-input" aria-label="${escapeHtml(column.label)} format"><option value="standard" ${column.style === "standard" ? "selected" : ""}>Standard</option><option value="strong" ${column.style === "strong" ? "selected" : ""}>Bold</option><option value="mono" ${column.style === "mono" ? "selected" : ""}>Monospace</option></select>
    <select class="column-visibility-input" aria-label="${escapeHtml(column.label)} visibility"><option value="always" ${column.visibility === "always" ? "selected" : ""}>Always</option><option value="nonempty" ${column.visibility === "nonempty" ? "selected" : ""}>Only with a value</option><option value="never" ${column.visibility === "never" ? "selected" : ""}>Hidden by default</option></select>
    <div class="column-flags"><label><input class="column-required-input" type="checkbox" ${column.required ? "checked" : ""}> Required</label><label><input class="column-unique-input" type="checkbox" ${column.unique ? "checked" : ""}> Unique</label></div>
    <label class="column-width"><input class="column-width-input" type="range" min="0.5" max="3" step="0.1" value="${column.width}"><span>${Number(column.width).toFixed(1)}×</span></label>
    <div class="column-actions"><button class="icon-button small" data-action="duplicate-column" title="Duplicate column">⧉</button><button class="icon-button small" data-action="delete-column" title="Delete column">×</button></div>
  </article>`).join("");
}

const operatorLabels = {
  not_empty: "has a value",
  empty: "is empty",
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  greater_than: "is greater than",
  less_than: "is less than",
  matches: "matches pattern",
};

const actionLabels = {
  show_field: "Show field",
  hide_field: "Hide field",
  include_row: "Include row",
  exclude_row: "Exclude row",
};

function actionOptions(selected) {
  return Object.entries(actionLabels).map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function operatorOptions(selected) {
  return Object.entries(operatorLabels).map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`).join("");
}

function renderRules() {
  const active = documentState.rules.filter((rule) => rule.enabled !== false).length;
  const testSelect = $("#ruleTestRowSelect");
  const testRows = documentState.rows;
  const testRow = testRows.find((row) => row.id === ui.ruleTestRowId);
  if (!testRow) ui.ruleTestRowId = "";
  if (testSelect) {
    testSelect.innerHTML = `<option value="">No row selected</option>${testRows.map((row, index) => { const label = documentState.columns.map((column) => String(row.values?.[column.id] ?? "").trim()).find(Boolean) || `Row ${index + 1}`; return `<option value="${escapeHtml(row.id)}">${escapeHtml(`Row ${index + 1} · ${label}`)}${row.disabled ? " · excluded" : ""}</option>`; }).join("")}`;
    testSelect.value = ui.ruleTestRowId;
    testSelect.disabled = !testRows.length;
  }
  const selectedTestRow = testRows.find((row) => row.id === ui.ruleTestRowId);
  $("#ruleTestStatus").textContent = selectedTestRow ? "Rule matches are shown on each card" : (testRows.length ? "Select a row to inspect its rule matches" : "Add or import rows to test rules");
  $("#ruleSummary").textContent = `${active} active rule${active === 1 ? "" : "s"} · ${documentState.rules.length} total`;
  $("#disableRulesButton").textContent = active ? "Disable all" : "Enable all";
  $("#ruleList").innerHTML = documentState.rules.map((rule, index) => { const matching = documentState.rows.filter((row) => ruleMatches(rule, row.values)).length; const testMatch = selectedTestRow && rule.enabled !== false ? ruleMatches(rule, selectedTestRow.values) : null; const testLabel = selectedTestRow ? (rule.enabled === false ? "Disabled" : testMatch ? "Matches test row" : "No match") : ""; return `<article class="rule-card ${rule.enabled === false ? "disabled" : ""}" data-rule-id="${rule.id}" draggable="true">
    <header class="rule-header"><span class="rule-number">${index + 1}</span><input class="rule-name-input" value="${escapeHtml(rule.name || actionLabels[rule.action] || "Rule")}" aria-label="Rule name"><span class="rule-match-count">${matching} matching</span>${testLabel ? `<span class="rule-test-chip ${testMatch ? "pass" : "fail"}">${escapeHtml(testLabel)}</span>` : ""}<label class="rule-enabled"><input class="rule-enabled-input" type="checkbox" ${rule.enabled !== false ? "checked" : ""}> Active</label><button class="icon-button small" data-action="duplicate-rule" title="Duplicate rule">⧉</button><button class="icon-button small" data-action="delete-rule" title="Delete rule">×</button></header>
    <div class="rule-body">
      <div class="rule-action-row"><span>Then</span><select class="rule-action-input">${actionOptions(rule.action)}</select><select class="rule-target-input" ${["include_row", "exclude_row"].includes(rule.action) ? "hidden" : ""}>${columnOptions(rule.target)}</select></div>
      <div class="conditions">
        ${(rule.conditions || []).map((condition, conditionIndex) => `<div class="condition-row" data-condition-index="${conditionIndex}"><span class="condition-join">${conditionIndex ? (rule.match === "any" ? "OR" : "AND") : "If"}</span><select class="condition-field">${columnOptions(condition.field)}</select><select class="condition-operator">${operatorOptions(condition.operator)}</select><input class="condition-value" value="${escapeHtml(condition.value || "")}" placeholder="Value" ${["empty", "not_empty"].includes(condition.operator) ? "hidden" : ""}><button class="condition-delete" data-action="delete-condition" title="Remove condition">×</button></div>`).join("")}
        <div class="condition-footer"><button class="text-button" data-action="add-condition">＋ Add condition</button><label class="match-control">Match<select class="rule-match-input"><option value="all" ${rule.match !== "any" ? "selected" : ""}>all conditions</option><option value="any" ${rule.match === "any" ? "selected" : ""}>any condition</option></select></label><label class="negate-control"><input class="rule-negate-input" type="checkbox" ${rule.negate ? "checked" : ""}> Not</label></div>
      </div>
    </div>
  </article>`; }).join("");
  $("#rulesEmpty").hidden = Boolean(documentState.rules.length);
}

function renderLayout() {
  const layout = documentState.layout;
  $$(".layout-mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === layout.mode));
  const bindings = {
    paperInput: layout.paper,
    orientationInput: layout.orientation,
    acrossInput: layout.across,
    flowInput: layout.flow,
    marginInput: layout.margin,
    gapInput: layout.gap,
    slipHeightInput: layout.slipHeight,
    accentInput: layout.accent,
    inkInput: layout.ink,
    paperColorInput: layout.paperColor,
    borderColorInput: layout.borderColor,
    labelSizeInput: layout.labelSize,
    valueSizeInput: layout.valueSize,
    fontInput: layout.font,
    labelCaseInput: layout.labelCase,
    fieldColumnsInput: layout.fieldColumns,
    labelPositionInput: layout.labelPosition,
    valueAlignInput: layout.valueAlign,
    labelWidthInput: layout.labelWidth,
    paddingInput: layout.padding,
    radiusInput: layout.radius,
    headerTextInput: layout.headerText,
    subtitleInput: layout.subtitle,
    footerTextInput: layout.footerText,
    headerStyleInput: layout.headerStyle,
  };
  Object.entries(bindings).forEach(([id, value]) => { $("#" + id).value = value; });
  $("#borderInput").checked = layout.showBorder;
  $("#cutMarksInput").checked = layout.cutMarks;
  $("#footerInput").checked = layout.footer;
  $("#fieldLinesInput").checked = layout.fieldLines;
  $("#zebraInput").checked = layout.zebra;
  $("#showBlankFieldsInput").checked = layout.showBlankFields;
  $("#logoStatus").textContent = layout.logoData ? "Logo loaded" : "No logo selected";
  $("#clearLogoButton").disabled = !layout.logoData;
  $("#slipHeightOutput").textContent = `${layout.slipHeight} mm`;
  renderLayoutPresets();
}

function renderLayoutPresets() {
  const presets = documentState.presets || [];
  $("#layoutPresetList").innerHTML = presets.length ? presets.map((preset) => `<div class="layout-preset" data-preset-id="${escapeHtml(preset.id)}"><button class="preset-apply" data-action="apply-preset"><strong>${escapeHtml(preset.name)}</strong><small>${escapeHtml(preset.layout.mode)} · ${String(preset.layout.paper || "a4").toUpperCase()} · ${preset.layout.across} across</small></button><button class="icon-button small" data-action="delete-preset" title="Delete saved layout">×</button></div>`).join("") : `<span class="preset-empty">No saved layouts yet.</span>`;
}

function saveLayoutPreset() {
  const input = $("#layoutPresetName");
  const name = input.value.trim();
  if (!name) { toast("Give this layout a name first", "error"); input.focus(); return; }
  commit((state) => { state.presets ||= []; state.presets.push({ id: uid("preset"), name, layout: clone(state.layout) }); });
  input.value = "";
  toast("Layout saved");
}

const modeDefaults = {
  horizontal: { columns: 0, label: "top" },
  stacked: { columns: 1, label: "left" },
  grid: { columns: 2, label: "top" },
  compact: { columns: 3, label: "inline" },
  dense: { columns: 4, label: "top" },
  cards: { columns: 2, label: "top" },
  ledger: { columns: 2, label: "left" },
  hero: { columns: 2, label: "top" },
  sections: { columns: 2, label: "top" },
};

function arrangement(layout = documentState.layout) {
  const preset = modeDefaults[layout.mode] || modeDefaults.grid;
  return {
    columns: Number(layout.fieldColumns) || preset.columns,
    label: layout.labelPosition === "preset" ? preset.label : layout.labelPosition,
  };
}

function effectiveLayout(row) {
  return { ...documentState.layout, ...(row.layoutOverride || {}) };
}

function formattedLabel(label, layout = documentState.layout) {
  if (layout.labelCase === "upper") return String(label).toUpperCase();
  if (layout.labelCase === "title") return String(label).replace(/\b\w/g, (letter) => letter.toUpperCase());
  return String(label);
}

function previewSlip(row) {
  const layout = effectiveLayout(row);
  const columns = visibleColumns(row);
  if (!columns.length) return `<div class="slip-preview blank-slip ${layout.showBorder ? "" : "no-border"}">Blank slip</div>`;
  const arranged = arrangement(layout);
  const selected = ui.selectedPreviewRow === row.id ? "selected-slip" : "";
  const font = layout.font === "Times-Roman" ? "Georgia, serif" : layout.font === "Courier" ? "ui-monospace, monospace" : "Inter, Arial, sans-serif";
  const weights = Array.from({ length: arranged.columns || columns.length }, (_, index) => Math.max(0.5, Number(columns[index]?.width) || 1));
  const style = `--field-columns:${arranged.columns || columns.length};--field-template:${weights.join("fr ")}fr;--label-width:${layout.labelWidth}%;--field-padding:${Math.max(1, layout.padding * .7)}px;--field-radius:${layout.radius * .7}px;--slip-bg:${layout.paperColor};--slip-ink:${layout.ink};--slip-border:${layout.borderColor};--preview-accent:${layout.accent};--value-align:${layout.valueAlign};--slip-font:${font};color:${layout.ink};`;
  const hasChrome = Boolean(layout.headerText || layout.subtitle || layout.footerText || layout.logoData);
  const classes = ["slip-preview", layout.mode, `labels-${arranged.label}`, hasChrome ? "with-chrome" : "", layout.showBorder ? "" : "no-border", layout.fieldLines ? "" : "no-field-lines", layout.zebra ? "zebra" : "", selected].filter(Boolean).join(" ");
  const logo = layout.logoData ? `<img class="slip-logo" src="${escapeHtml(layout.logoData)}" alt="">` : "";
  const headerCopy = layout.headerText || layout.subtitle ? `<span class="slip-heading-copy"><strong>${escapeHtml(layout.headerText)}</strong><span>${escapeHtml(layout.subtitle)}</span></span>` : "";
  const header = hasChrome && (layout.headerText || layout.subtitle || layout.logoData) ? `<header class="slip-heading ${escapeHtml(layout.headerStyle)}">${logo}${headerCopy}</header>` : "";
  const footer = layout.footerText ? `<footer class="slip-note">${escapeHtml(layout.footerText)}</footer>` : "";
  const fieldMarkup = (column, index = 0) => { const alignment = column.valueAlign && column.valueAlign !== "default" ? column.valueAlign : layout.valueAlign; return `<div class="preview-field ${layout.mode === "hero" && index === 0 ? "hero-primary" : ""}"><span class="field-label" style="font-size:${Math.max(4, layout.labelSize * .44)}px">${escapeHtml(formattedLabel(column.label, layout))}</span><span class="field-value ${escapeHtml(column.style)}" style="font-size:${Math.max(4, layout.valueSize * .48)}px;text-align:${escapeHtml(alignment)}">${escapeHtml(formatValue(row.values[column.id] ?? "", column))}</span></div>`; };
  const fields = layout.mode === "sections" ? (() => {
    const groups = [];
    const byGroup = new Map();
    columns.forEach((column) => {
      const key = String(column.group || "").trim() || "Fields";
      if (!byGroup.has(key)) { const group = { name: key, columns: [] }; byGroup.set(key, group); groups.push(group); }
      byGroup.get(key).columns.push(column);
    });
    const sectionColumns = Math.max(1, arranged.columns || 2);
    return `<div class="slip-sections">${groups.map((group) => {
      const weights = group.columns.slice(0, sectionColumns).map((column) => Math.max(.5, Number(column.width) || 1));
      const template = weights.length ? `${weights.join("fr ")}fr` : "1fr";
      return `<section class="slip-section"><div class="slip-section-heading">${escapeHtml(group.name)}</div><div class="slip-section-fields" style="--section-columns:${Math.min(sectionColumns, group.columns.length)};--section-template:${template}">${group.columns.map((column, index) => fieldMarkup(column, index)).join("")}</div></section>`;
    }).join("")}</div>`;
  })() : `<div class="slip-fields">${columns.map((column, index) => fieldMarkup(column, index)).join("")}</div>`;
  return `<div class="${classes}" style="${style}" data-preview-row-id="${row.id}" title="Select row in preview">${header}${fields}${footer}</div>`;
}

function renderPreview() {
  const layout = documentState.layout;
  const rows = includedRows();
  if (ui.selectedPreviewRow && !rows.some((row) => row.id === ui.selectedPreviewRow)) ui.selectedPreviewRow = null;
  const paper = $("#paperPreview");
  const portraitWidth = layout.paper === "letter" ? 306 : 298;
  const portraitHeight = layout.paper === "letter" ? 396 : 421;
  const landscape = layout.orientation === "landscape";
  const width = landscape ? portraitHeight : portraitWidth;
  const height = landscape ? portraitWidth : portraitHeight;
  const pxPerMm = width / (landscape ? (layout.paper === "letter" ? 279.4 : 297) : (layout.paper === "letter" ? 215.9 : 210));
  const margin = layout.margin * pxPerMm;
  const gap = layout.gap * pxPerMm;
  const slipHeight = layout.slipHeight * pxPerMm;
  const footerRoom = layout.footer ? 12 : 0;
  const down = Math.max(1, Math.floor((height - margin * 2 - footerRoom + gap) / (slipHeight + gap)));
  const perPage = down * layout.across;
  paper.classList.toggle("landscape", landscape);
  paper.dataset.across = layout.across;
  paper.style.width = `${width}px`;
  paper.style.minHeight = `${height}px`;
  paper.style.setProperty("--preview-scale", ui.zoom);
  paper.style.setProperty("--paper-margin", `${margin}px`);
  paper.style.setProperty("--paper-gap", `${gap}px`);
  paper.style.setProperty("--slip-height", `${slipHeight}px`);
  paper.style.setProperty("--preview-accent", layout.accent);
  paper.style.setProperty("--slip-border", layout.borderColor);
  paper.style.gridTemplateRows = `repeat(${down}, ${slipHeight}px)`;
  if (layout.flow === "columns") {
    paper.style.gridAutoFlow = "column";
    paper.style.gridTemplateRows = `repeat(${down}, ${slipHeight}px)`;
  } else {
    paper.style.gridAutoFlow = "row";
  }
  const pages = rows.length ? Math.ceil(rows.length / perPage) : 0;
  ui.previewPage = Math.min(ui.previewPage, Math.max(0, pages - 1));
  const pageNumber = pages ? ui.previewPage + 1 : 0;
  const shown = rows.slice(ui.previewPage * perPage, (ui.previewPage + 1) * perPage);
  paper.innerHTML = shown.map(previewSlip).join("") + (layout.footer && rows.length ? `<div class="paper-footer"><span>${escapeHtml(documentState.name)}</span><span>Page ${pageNumber} of ${pages}</span></div>` : "");
  $("#previewStats").textContent = rows.length ? `${layout.paper.toUpperCase()} · ${perPage} per page · ${pages} page${pages === 1 ? "" : "s"}` : `${layout.paper.toUpperCase()} · 0 slips`;
  $("#previewPageLabel").textContent = rows.length ? `Page ${pageNumber} / ${pages}` : "No pages";
  $("#previewPrevButton").disabled = !rows.length || ui.previewPage <= 0;
  $("#previewNextButton").disabled = !rows.length || ui.previewPage >= pages - 1;
  $("#includedCount").textContent = `${rows.length} included`;
  $("#excludedCount").textContent = `${documentState.rows.length - rows.length} excluded`;
  $("#zoomLabel").textContent = `${Math.round(ui.zoom * 100)}%`;
}

function addRow() {
  const row = { id: uid("row"), values: Object.fromEntries(documentState.columns.map((column) => [column.id, ""])), disabled: false, overrides: {}, layoutOverride: {} };
  commit((state) => state.rows.push(row));
  showView("data");
  requestAnimationFrame(() => $(`[data-row-id="${row.id}"] .cell-input`)?.focus());
}

function addColumn(label = "New column") {
  const id = uniqueColumnId(label);
  commit((state) => {
    state.columns.push({ id, label, group: "", type: "text", style: "standard", valueAlign: "default", visibility: "always", width: 1 });
    state.rows.forEach((row) => { row.values[id] = ""; });
  });
  showView("columns");
  requestAnimationFrame(() => $(`[data-column-id="${id}"] .column-label-input`)?.select());
}

function uniqueColumnId(label, existing = documentState.columns) {
  const base = String(label || "column").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "column";
  const ids = new Set(existing.map((column) => column.id));
  let candidate = base;
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function addRule() {
  const first = documentState.columns[0]?.id || "";
  const rule = { id: uid("rule"), name: "New rule", enabled: true, action: "hide_field", target: first, match: "all", conditions: [{ field: first, operator: "empty", value: "" }] };
  commit((state) => state.rules.push(rule));
  showView("rules");
}

function openRowOptions(rowId) {
  const row = documentState.rows.find((item) => item.id === rowId);
  if (!row) return;
  ui.rowOptionsId = rowId;
  $("#rowOptionsName").textContent = documentState.columns.map((column) => row.values[column.id]).find(Boolean) || `Row ${documentState.rows.indexOf(row) + 1}`;
  $("#rowIncludedInput").checked = !row.disabled;
  const layoutOverride = row.layoutOverride || {};
  $("#rowLayoutEnabledInput").checked = Object.keys(layoutOverride).length > 0;
  renderRowPresetOptions();
  syncRowLogoStatus(row, layoutOverride);
  $("#rowModeInput").value = layoutOverride.mode || "";
  $("#rowFieldColumnsInput").value = layoutOverride.fieldColumns == null ? "" : String(layoutOverride.fieldColumns);
  $("#rowLabelPositionInput").value = layoutOverride.labelPosition || "";
  $("#rowValueAlignInput").value = layoutOverride.valueAlign || "";
  $("#rowAccentInput").value = layoutOverride.accent || documentState.layout.accent;
  $("#rowPaperColorInput").value = layoutOverride.paperColor || documentState.layout.paperColor;
  $("#rowHeaderTextInput").value = layoutOverride.headerText || "";
  $("#rowSubtitleInput").value = layoutOverride.subtitle || "";
  $("#rowFooterTextInput").value = layoutOverride.footerText || "";
  $("#rowHeaderStyleInput").value = layoutOverride.headerStyle || "";
  $("#rowFontInput").value = layoutOverride.font || "";
  $("#rowLabelCaseInput").value = layoutOverride.labelCase || "";
  $("#rowLabelSizeInput").value = layoutOverride.labelSize == null ? "" : String(layoutOverride.labelSize);
  $("#rowValueSizeInput").value = layoutOverride.valueSize == null ? "" : String(layoutOverride.valueSize);
  $("#rowLabelWidthInput").value = layoutOverride.labelWidth == null ? "" : String(layoutOverride.labelWidth);
  $("#rowPaddingInput").value = layoutOverride.padding == null ? "" : String(layoutOverride.padding);
  $("#rowRadiusInput").value = layoutOverride.radius == null ? "" : String(layoutOverride.radius);
  $("#rowInkInput").value = layoutOverride.ink || documentState.layout.ink;
  $("#rowBorderColorInput").value = layoutOverride.borderColor || documentState.layout.borderColor;
  $("#rowBorderInput").checked = layoutOverride.showBorder == null ? documentState.layout.showBorder : Boolean(layoutOverride.showBorder);
  $("#rowFieldLinesInput").checked = layoutOverride.fieldLines == null ? documentState.layout.fieldLines : Boolean(layoutOverride.fieldLines);
  $("#rowZebraInput").checked = layoutOverride.zebra == null ? documentState.layout.zebra : Boolean(layoutOverride.zebra);
  renderRowFieldOrder(row);
  syncRowLayoutControls();
  syncRowLogoStatus(row, layoutOverride);
  $("#rowOverrideList").innerHTML = documentState.columns.map((column) => `<label class="override-row"><strong>${escapeHtml(column.label)}</strong><select data-column-id="${column.id}"><option value="auto" ${row.overrides[column.id] == null ? "selected" : ""}>Automatic</option><option value="show" ${row.overrides[column.id] === true ? "selected" : ""}>Always show</option><option value="hide" ${row.overrides[column.id] === false ? "selected" : ""}>Always hide</option></select></label>`).join("");
  if (!$("#rowOptionsDialog").open) $("#rowOptionsDialog").showModal();
}

function renderRowPresetOptions() {
  const select = $("#rowPresetInput");
  if (!select) return;
  const presets = documentState.presets || [];
  select.innerHTML = `<option value="">${presets.length ? "Choose a saved layout" : "No saved layouts yet"}</option>${presets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`).join("")}`;
  select.disabled = !presets.length;
  $("#applyRowPresetButton").disabled = !presets.length;
}

function applyRowPreset() {
  const preset = (documentState.presets || []).find((item) => item.id === $("#rowPresetInput").value);
  const row = documentState.rows.find((item) => item.id === ui.rowOptionsId);
  if (!preset || !row) { toast("Choose a saved layout first", "error"); return; }
  const override = Object.fromEntries(rowPresetKeys.filter((key) => Object.prototype.hasOwnProperty.call(preset.layout || {}, key)).map((key) => [key, clone(preset.layout[key])]));
  if (!override.logoData) delete override.logoData;
  commit((state) => {
    const target = state.rows.find((item) => item.id === ui.rowOptionsId);
    if (target) target.layoutOverride = override;
  });
  openRowOptions(row.id);
  toast(`Applied “${preset.name}” to this slip`);
}

function syncRowLogoStatus(row, override = row?.layoutOverride || {}) {
  const hasOverride = Object.prototype.hasOwnProperty.call(override, "logoData");
  const hasLogo = Boolean(override.logoData);
  const sheetHasLogo = Boolean(documentState.layout.logoData);
  $("#rowLogoStatus").textContent = hasOverride ? (hasLogo ? "Row logo loaded" : "Sheet logo hidden for this row") : (sheetHasLogo ? "Using sheet logo" : "No logo selected");
  $("#clearRowLogoButton").disabled = !hasOverride || !$("#rowLayoutEnabledInput").checked;
}

function setRowLogoData(logoData) {
  commit((state) => {
    const row = state.rows.find((item) => item.id === ui.rowOptionsId);
    if (!row) return;
    row.layoutOverride ||= {};
    row.layoutOverride.logoData = logoData;
  });
  const row = documentState.rows.find((item) => item.id === ui.rowOptionsId);
  if (row) {
    $("#rowLayoutEnabledInput").checked = Boolean(row.layoutOverride && Object.keys(row.layoutOverride).length);
    syncRowLayoutControls();
    syncRowLogoStatus(row);
  }
}

function clearRowLogoOverride() {
  commit((state) => {
    const row = state.rows.find((item) => item.id === ui.rowOptionsId);
    if (!row) return;
    if (row.layoutOverride) {
      delete row.layoutOverride.logoData;
      if (!Object.keys(row.layoutOverride).length) delete row.layoutOverride;
    }
  });
  const row = documentState.rows.find((item) => item.id === ui.rowOptionsId);
  if (row) {
    $("#rowLayoutEnabledInput").checked = Boolean(row.layoutOverride && Object.keys(row.layoutOverride).length);
    syncRowLayoutControls();
    syncRowLogoStatus(row);
  }
}

function renderRowFieldOrder(row) {
  const ordered = sortColumnsForRow(documentState.columns, row);
  $("#rowFieldOrderList").innerHTML = ordered.map((column) => `<div class="row-order-item" data-column-id="${escapeHtml(column.id)}" draggable="true"><button class="drag-handle" type="button" tabindex="-1" aria-label="Drag ${escapeHtml(column.label)}">⠿</button><span>${escapeHtml(column.label)}</span><small>${escapeHtml(column.id)}</small></div>`).join("");
}

function syncRowLayoutControls() {
  const enabled = $("#rowLayoutEnabledInput").checked;
  $("#rowLayoutControls").classList.toggle("disabled-controls", !enabled);
  $("#rowLayoutControls").querySelectorAll("select, input, button").forEach((control) => { control.disabled = !enabled; });
  $("#rowLayoutEnabledInput").disabled = false;
}

function updateRowLayout(key, value, enabled = true) {
  commit((state) => {
    const row = state.rows.find((item) => item.id === ui.rowOptionsId);
    if (!row) return;
    row.layoutOverride ||= {};
    if (value === "") delete row.layoutOverride[key];
    else row.layoutOverride[key] = value;
    if (!Object.keys(row.layoutOverride).length) delete row.layoutOverride;
  });
  if (enabled) syncRowLayoutControls();
}

function setRowFieldOrder(order) {
  commit((state) => {
    const row = state.rows.find((item) => item.id === ui.rowOptionsId);
    if (!row) return;
    const globalOrder = state.columns.map((column) => column.id);
    row.layoutOverride ||= {};
    if (order.join("|") === globalOrder.join("|")) delete row.layoutOverride.columnOrder;
    else row.layoutOverride.columnOrder = order;
    if (!Object.keys(row.layoutOverride).length) delete row.layoutOverride;
  });
  const row = documentState.rows.find((item) => item.id === ui.rowOptionsId);
  if (row) renderRowFieldOrder(row);
}

function toast(message, type = "") {
  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  $("#toastRegion").append(element);
  setTimeout(() => element.remove(), 3200);
}

function confirmAction(title, message, label = "Confirm") {
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmActionButton").textContent = label;
  const dialog = $("#confirmDialog");
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const lines = [documentState.columns.map((column) => csvCell(column.label)).join(",")];
  documentState.rows.forEach((row) => lines.push(documentState.columns.map((column) => csvCell(row.values?.[column.id] || "")).join(",")));
  downloadBlob(new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" }), `${safeFilename(documentState.name)}.csv`);
  toast("CSV exported");
}

function parseClipboardGrid(text) {
  const normalised = String(text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!normalised) return [];
  return normalised.split("\n").map((line) => line.split("\t"));
}

function pasteIntoDataGrid(event) {
  const input = event.target.closest(".cell-input");
  const text = event.clipboardData?.getData("text/plain") || "";
  if (!input || (!text.includes("\t") && !text.includes("\n"))) return;
  const grid = parseClipboardGrid(text);
  if (!grid.length) return;
  const rowElement = input.closest("tr[data-row-id]");
  const rowId = rowElement?.dataset.rowId;
  const columnId = input.dataset.columnId;
  const visible = filteredRows();
  const visibleStart = visible.findIndex((row) => row.id === rowId);
  const columnStart = documentState.columns.findIndex((column) => column.id === columnId);
  if (visibleStart < 0 || columnStart < 0) return;
  const writableColumns = documentState.columns.length - columnStart;
  if (!writableColumns) return;
  const rowIds = visible.slice(visibleStart, visibleStart + grid.length).map((row) => row.id);
  const additions = Math.max(0, grid.length - rowIds.length);
  event.preventDefault();
  commit((state) => {
    for (let index = 0; index < additions; index += 1) {
      const row = { id: uid("row"), values: Object.fromEntries(state.columns.map((column) => [column.id, ""])), disabled: false, overrides: {}, layoutOverride: {} };
      state.rows.push(row);
      rowIds.push(row.id);
    }
    grid.forEach((line, rowOffset) => {
      const row = state.rows.find((item) => item.id === rowIds[rowOffset]);
      if (!row) return;
      line.slice(0, writableColumns).forEach((value, columnOffset) => {
        row.values[state.columns[columnStart + columnOffset].id] = value;
      });
    });
  });
  const cells = grid.reduce((total, line) => total + Math.min(line.length, writableColumns), 0);
  toast(`Pasted ${cells} cell${cells === 1 ? "" : "s"} across ${grid.length} row${grid.length === 1 ? "" : "s"}`);
}

async function copyVisibleRows() {
  const rows = filteredRows();
  const text = [documentState.columns.map((column) => column.label).join("\t"), ...rows.map((row) => documentState.columns.map((column) => String(row.values?.[column.id] ?? "")).join("\t"))].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast(`${rows.length} row${rows.length === 1 ? "" : "s"} copied`);
  } catch (_) {
    toast("Clipboard access was not available", "error");
  }
}

function safeFilename(value) {
  return String(value || "password-slips").replace(/[^a-z0-9._ -]+/gi, "").trim() || "password-slips";
}

function exportValidationIssues(source) {
  const columns = Array.isArray(source.columns) ? source.columns : [];
  const rows = Array.isArray(source.rows) ? source.rows.filter((row) => !row.disabled) : [];
  const incompleteRows = rows.filter((row) => columns.some((column) => column.required && !String(row.values?.[column.id] ?? "").trim()));
  const duplicateCounts = duplicateValueCounts(rows, columns);
  const duplicateRows = rows.filter((row) => columns.some((column) => hasDuplicateValue(row, column, duplicateCounts)));
  const invalidRows = rows.filter((row) => columns.some((column) => valueValidationIssue(row, column)));
  return { incompleteRows, duplicateRows, invalidRows };
}

async function exportPdf(source = documentState, filenameSuffix = "", triggerButton = null) {
  const issues = exportValidationIssues(source);
  const warnings = [];
  if (issues.incompleteRows.length) warnings.push(`${issues.incompleteRows.length} row${issues.incompleteRows.length === 1 ? " is" : "s are"} missing required values`);
  if (issues.duplicateRows.length) warnings.push(`${issues.duplicateRows.length} row${issues.duplicateRows.length === 1 ? " has" : "s have"} duplicate unique values`);
  if (issues.invalidRows.length) warnings.push(`${issues.invalidRows.length} row${issues.invalidRows.length === 1 ? " has" : "s have"} invalid typed values`);
  if (warnings.length && !await confirmAction("Export with data warnings?", `${warnings.join(" and ")}. The PDF can still be exported, but review the affected rows first.`, "Export anyway")) return;
  const button = triggerButton || $("#exportPdfButton");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Exporting…";
  try {
    const response = await fetch("/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: source }) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "PDF export failed.");
    }
    downloadBlob(await response.blob(), `${safeFilename(source.name)}${filenameSuffix}.pdf`);
    toast("PDF exported");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function exportSelectedRows() {
  const ids = new Set(ui.selectedRows);
  const rows = includedRows().filter((row) => ids.has(row.id));
  if (!rows.length) { toast("Select at least one included row", "error"); return; }
  const source = clone(documentState);
  source.rows = rows.map((row) => ({ ...clone(row), disabled: false }));
  await exportPdf(source, "-selected");
}

async function exportVisibleRows() {
  const included = new Set(includedRows().map((row) => row.id));
  const rows = filteredRows().filter((row) => included.has(row.id));
  if (!rows.length) { toast("There are no included rows in the current view", "error"); return; }
  const source = clone(documentState);
  source.rows = rows.map((row) => ({ ...clone(row), disabled: false }));
  await exportPdf(source, "-view", $("#exportVisibleButton"));
}

function saveProject() {
  const blob = new Blob([JSON.stringify(documentState, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${safeFilename(documentState.name)}.password-slips.json`);
  toast("Studio file saved");
}

async function openProjectFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) throw new Error("This is not a Password Slip Studio file.");
    pushHistory();
    documentState = normaliseDocument(parsed);
    ui.selectedRows.clear();
    ui.dataPage = 0;
    changed();
    renderAll();
    toast("Studio file opened");
  } catch (error) {
    toast(error.message || "The studio file could not be opened.", "error");
  }
}

function resetImportDialog() {
  ui.importData = null;
  $("#importChoose").hidden = false;
  $("#importMap").hidden = true;
  $("#confirmImportButton").hidden = true;
  $("#importStepLabel").textContent = "Choose a workbook";
  $("#importMeta").textContent = "";
  $("#workbookInput").value = "";
  $("#importMode").value = "replace";
  $("#importProjectName").value = "";
  $("#importProjectName").placeholder = documentState.name;
  updateImportModeNotice();
}

function openImport() {
  resetImportDialog();
  $("#importDialog").showModal();
}

async function importWorkbook(file) {
  if (!file) return;
  $("#importMeta").textContent = `Reading ${file.name}…`;
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const content = String(dataUrl).split(",", 2)[1];
    const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, content }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The workbook could not be imported.");
    ui.importData = payload;
    $("#importSheetSelect").innerHTML = payload.sheets.map((sheet, index) => `<option value="${index}">${escapeHtml(sheet.name)} · ${sheet.rows.length} rows</option>`).join("");
    $("#importChoose").hidden = true;
    $("#importMap").hidden = false;
    $("#confirmImportButton").hidden = false;
    $("#importStepLabel").textContent = "Map sheet columns";
    $("#importProjectName").placeholder = String(file.name).replace(/\.(xlsx|xlsm|csv)$/i, "") || documentState.name;
    renderImportMapping();
  } catch (error) {
    $("#importMeta").textContent = "";
    toast(error.message || "The workbook could not be imported.", "error");
  }
}

function guessedMapping(header) {
  const normal = String(header).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const match = documentState.columns.find((column) => column.id.toLowerCase().replace(/[^a-z0-9]+/g, "") === normal || column.label.toLowerCase().replace(/[^a-z0-9]+/g, "") === normal);
  if (match) return match.id;
  const semantic = (pattern) => documentState.columns.find((column) => pattern.test(`${column.id} ${column.label}`.toLowerCase()));
  if (/(password|passcode|passwd|pwd|temporarypass)/.test(normal)) return semantic(/password|passcode|passwd|pwd/ )?.id || "__create__";
  if (/(username|userlogin|loginname|accountname|samaccount)/.test(normal)) return semantic(/username|login|account/ )?.id || "__create__";
  if (/(recovery|backup|mfa|otp|authenticator|securitycode)/.test(normal)) return semantic(/recovery|code|otp|mfa/ )?.id || "__create__";
  return "__create__";
}

function inferImportedColumnType(header, values) {
  const normal = String(header).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (/(password|passcode|passwd|pwd|pin|secret|recovery|otp|mfa|securitycode)/.test(normal)) return "password";
  if (/(url|uri|link|website|webaddress|portal|endpoint)/.test(normal)) return "url";
  if (/(date|time|created|updated|expires|expiry|timestamp)/.test(normal)) return "date";
  const samples = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (samples.length && samples.every((value) => /^[-+]?\d+(?:\.\d+)?$/.test(value))) return "number";
  return "text";
}

function currentImportMappings() {
  return $$(".mapping-row", $("#mappingList")).map((row, sourceIndex) => ({ sourceIndex, target: row.querySelector("select").value, header: row.dataset.sourceHeader || "" }));
}

function updateMappingSummary() {
  const mappings = currentImportMappings();
  const mapped = mappings.filter((item) => item.target !== "__skip__");
  const created = mapped.filter((item) => item.target === "__create__").length;
  const existing = mapped.length - created;
  const skipped = mappings.length - mapped.length;
  const duplicateTargets = [...new Set(mapped.filter((item) => item.target !== "__create__").map((item) => item.target).filter((target, index, list) => list.indexOf(target) !== index))];
  $("#mappingSummary").textContent = `${existing} existing field${existing === 1 ? "" : "s"} · ${created} new field${created === 1 ? "" : "s"} · ${skipped} skipped${duplicateTargets.length ? ` · ${duplicateTargets.length} duplicate mapping${duplicateTargets.length === 1 ? "" : "s"}` : ""}`;
  return duplicateTargets;
}

function updateImportWarning() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  const duplicates = updateMappingSummary();
  const warnings = [];
  if (sheet?.truncated) warnings.push("This sheet was limited to the first 20,000 non-empty rows.");
  if (duplicates.length) warnings.push("Two or more sheet columns map to the same studio field. The last mapped column will win; remap or skip duplicates before importing.");
  $("#importWarning").hidden = !warnings.length;
  $("#importWarning").textContent = warnings.join(" ");
}

function renderImportMapping() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  if (!sheet) return;
  const options = documentState.columns.map((column) => `<option value="${column.id}">${escapeHtml(column.label)}</option>`).join("");
  $("#mappingList").innerHTML = sheet.headers.map((header, index) => {
    const guessed = guessedMapping(header);
    return `<div class="mapping-row" data-source-index="${index}" data-source-header="${escapeHtml(header)}"><span class="mapping-source">${escapeHtml(header)}</span><select class="mapping-select"><option value="__skip__">Skip</option><option value="__create__" ${guessed === "__create__" ? "selected" : ""}>Create “${escapeHtml(header)}”</option>${options}</select><span class="mapping-sample">${escapeHtml(sheet.rows.find((row) => row[index])?.[index] || "—")}</span></div>`;
  }).join("");
  $$(".mapping-row", $("#mappingList")).forEach((row, index) => { row.querySelector("select").value = guessedMapping(sheet.headers[index]); });
  $("#importMeta").textContent = `${escapeHtml(ui.importData.filename)} · ${sheet.rows.length} rows`;
  updateImportWarning();
  updateImportModeNotice();
}

function updateImportModeNotice() {
  const replace = $("#importMode").value === "replace";
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  const incoming = sheet?.rows?.length || 0;
  $("#importModeNotice").textContent = replace
    ? `All ${documentState.rows.length} existing rows will be removed and replaced by ${incoming || "the imported"} spreadsheet rows.`
    : `${incoming || "The imported"} spreadsheet rows will be added after the current ${documentState.rows.length} rows.`;
  $("#confirmImportButton").textContent = replace ? "Replace rows" : "Import rows";
}

function confirmImport() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  if (!sheet) return;
  const replaceRows = $("#importMode").value === "replace";
  const mappings = $$(".mapping-row", $("#mappingList")).map((row, sourceIndex) => ({ sourceIndex, target: row.querySelector("select").value, header: sheet.headers[sourceIndex] }));
  if (!mappings.some((mapping) => mapping.target !== "__skip__")) {
    toast("Map at least one sheet column.", "error");
    return;
  }
  const duplicateTargets = [...new Set(mappings.filter((mapping) => mapping.target !== "__skip__" && mapping.target !== "__create__").map((mapping) => mapping.target).filter((target, index, list) => list.indexOf(target) !== index))];
  if (duplicateTargets.length) {
    toast("Resolve duplicate field mappings before importing.", "error");
    return;
  }
  commit((state) => {
    const targetIds = new Map();
    mappings.forEach((mapping) => {
      if (mapping.target === "__skip__") return;
      if (mapping.target === "__create__") {
        const id = uniqueColumnId(mapping.header, state.columns);
        const type = inferImportedColumnType(mapping.header, sheet.rows.map((row) => row[mapping.sourceIndex]));
        state.columns.push({ id, label: mapping.header, group: "", type, style: type === "password" ? "mono" : "standard", valueAlign: "default", visibility: "always", width: 1 });
        state.rows.forEach((row) => { row.values[id] = ""; });
        targetIds.set(mapping.sourceIndex, id);
      } else {
        targetIds.set(mapping.sourceIndex, mapping.target);
      }
    });
    const imported = sheet.rows.map((source) => {
      const values = Object.fromEntries(state.columns.map((column) => [column.id, ""]));
      targetIds.forEach((target, sourceIndex) => { values[target] = String(source[sourceIndex] ?? ""); });
      return { id: uid("row"), values, disabled: false, overrides: {}, layoutOverride: {} };
    });
    if (replaceRows) state.rows = imported;
    else state.rows.push(...imported);
    const customName = $("#importProjectName").value.trim();
    if (customName) state.name = customName;
  });
  ui.dataPage = 0;
  $("#importDialog").close();
  showView("data");
  toast(`${sheet.rows.length} row${sheet.rows.length === 1 ? "" : "s"} ${replaceRows ? "replaced the current data" : "imported"}`);
}

function commandActions() {
  return [
    { icon: "⇧", label: "Import spreadsheet", detail: "XLSX, XLSM or CSV", run: openImport },
    { icon: "＋", label: "Add row", detail: "Manual entry", run: addRow },
    { icon: "⫶", label: "Add column", detail: "Define a new field", run: () => addColumn() },
    { icon: "⌁", label: "Add rule", detail: "Conditional visibility or row filter", run: addRule },
    { icon: "▦", label: "Go to Data", detail: "D", run: () => showView("data") },
    { icon: "⫶", label: "Go to Columns", detail: "", run: () => showView("columns") },
    { icon: "⌁", label: "Go to Rules", detail: "", run: () => showView("rules") },
    { icon: "▤", label: "Go to Layout", detail: "L", run: () => showView("layout") },
    { icon: "↓", label: "Export PDF", detail: "⇧⌘E", run: exportPdf },
    { icon: "↓", label: "Export current view", detail: "Filtered PDF", run: exportVisibleRows },
    { icon: "↓", label: "Export CSV", detail: "Data", run: exportCsv },
    { icon: "⧉", label: "Copy visible rows", detail: "Data", run: copyVisibleRows },
    { icon: "✎", label: "Bulk edit selected rows", detail: "Selection", run: openBulkEdit },
    { icon: "☆", label: "Save data view", detail: "Filter and sort", run: saveDataView },
    { icon: "◇", label: "Save studio file", detail: "", run: saveProject },
    { icon: "◐", label: "Toggle theme", detail: "", run: toggleTheme },
  ];
}

function filteredCommands() {
  const query = $("#commandInput").value.trim().toLowerCase();
  return commandActions().filter((action) => !query || `${action.label} ${action.detail}`.toLowerCase().includes(query));
}

function renderCommands() {
  const actions = filteredCommands();
  ui.commandIndex = Math.min(ui.commandIndex, Math.max(0, actions.length - 1));
  $("#commandList").innerHTML = actions.length ? actions.map((action, index) => `<button class="command-item ${index === ui.commandIndex ? "selected" : ""}" data-command-index="${index}" role="option" aria-selected="${index === ui.commandIndex}"><span>${action.icon}</span><strong>${escapeHtml(action.label)}</strong><small>${escapeHtml(action.detail)}</small></button>`).join("") : `<div class="empty-state compact-empty">No matching commands</div>`;
}

function openCommands() {
  ui.commandIndex = 0;
  $("#commandInput").value = "";
  renderCommands();
  $("#commandDialog").showModal();
  requestAnimationFrame(() => $("#commandInput").focus());
}

function runCommand(index) {
  const action = filteredCommands()[index];
  if (!action) return;
  $("#commandDialog").close();
  action.run();
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("pss-theme", next);
}

function setPreviewWidth(value, persist = true) {
  ui.previewWidth = clampPreviewWidth(value);
  document.documentElement.style.setProperty("--preview-width", `${ui.previewWidth}px`);
  const handle = $("#previewResizeHandle");
  if (handle) handle.setAttribute("aria-valuenow", String(ui.previewWidth));
  if (persist) {
    try { localStorage.setItem("pss-preview-width", String(ui.previewWidth)); } catch (_) {}
  }
}

function installPreviewResize() {
  const handle = $("#previewResizeHandle");
  if (!handle) return;
  let drag = null;
  const finish = (event) => {
    if (!drag) return;
    if (event?.pointerId != null && handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    drag = null;
    handle.classList.remove("dragging");
    setPreviewWidth(ui.previewWidth);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 860px)").matches) return;
    drag = { startX: event.clientX, startWidth: ui.previewWidth };
    handle.classList.add("dragging");
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (!drag) return;
    setPreviewWidth(drag.startWidth + drag.startX - event.clientX, false);
  });
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowLeft") { event.preventDefault(); setPreviewWidth(ui.previewWidth + step); }
    if (event.key === "ArrowRight") { event.preventDefault(); setPreviewWidth(ui.previewWidth - step); }
    if (event.key === "Home") { event.preventDefault(); setPreviewWidth(PREVIEW_MIN_WIDTH); }
    if (event.key === "End") { event.preventDefault(); setPreviewWidth(PREVIEW_MAX_WIDTH); }
  });
}

function installEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  ["#addRowButton", "#addRowRailButton", "#appendRowButton"].forEach((selector) => $(selector).addEventListener("click", addRow));
  ["#importButton", "#dataImportButton"].forEach((selector) => $(selector).addEventListener("click", openImport));
  $("#addColumnButton").addEventListener("click", () => addColumn());
  $("#addRuleButton").addEventListener("click", addRule);
  $("#commandButton").addEventListener("click", openCommands);
  $("#exportPdfButton").addEventListener("click", exportPdf);
  $("#exportSelectedButton").addEventListener("click", exportSelectedRows);
  $("#exportCsvButton").addEventListener("click", exportCsv);
  $("#exportVisibleButton").addEventListener("click", exportVisibleRows);
  $("#saveProjectButton").addEventListener("click", saveProject);
  $("#openProjectButton").addEventListener("click", () => $("#openProjectInput").click());
  $("#openProjectInput").addEventListener("change", (event) => openProjectFile(event.target.files[0]));
  $("#themeButton").addEventListener("click", toggleTheme);
  installPreviewResize();
  $("#undoButton").addEventListener("click", undo);
  $("#redoButton").addEventListener("click", redo);
  $("#documentName").addEventListener("change", (event) => commit((state) => { state.name = event.target.value.trim() || "Untitled password slips"; }));
  $("#rowSearch").addEventListener("input", (event) => { ui.search = event.target.value; ui.dataPage = 0; renderData(); });
  $("#sortColumn").addEventListener("change", (event) => { ui.sortColumn = event.target.value; ui.dataPage = 0; renderData(); });
  $("#sortDirection").addEventListener("change", (event) => { ui.sortDirection = event.target.value; ui.dataPage = 0; renderData(); });
  $("#pageSizeInput").addEventListener("change", (event) => { ui.pageSize = Math.max(1, Number(event.target.value) || 50); ui.dataPage = 0; renderData(); });
  $("#dataPrevButton").addEventListener("click", () => { ui.dataPage = Math.max(0, ui.dataPage - 1); renderData(); });
  $("#dataNextButton").addEventListener("click", () => { ui.dataPage += 1; renderData(); });
  $("#savedViewSelect").addEventListener("change", (event) => applyDataView(event.target.value));
  $("#saveDataViewButton").addEventListener("click", saveDataView);
  $("#deleteDataViewButton").addEventListener("click", deleteDataView);
  $("#confirmSaveDataViewButton").addEventListener("click", () => commitDataView($("#saveDataViewName").value));
  $("#saveDataViewName").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commitDataView(event.target.value); } });

  $("#dataView").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "add-row") addRow();
    if (action === "import") openImport();
  });

  $("#dataHead").addEventListener("change", (event) => {
    if (event.target.id !== "selectAllRows") return;
    filteredRows().forEach((row) => event.target.checked ? ui.selectedRows.add(row.id) : ui.selectedRows.delete(row.id));
    renderData();
  });

  $("#dataBody").addEventListener("change", (event) => {
    const rowElement = event.target.closest("tr[data-row-id]");
    if (!rowElement) return;
    const rowId = rowElement.dataset.rowId;
    if (event.target.classList.contains("row-select")) {
      event.target.checked ? ui.selectedRows.add(rowId) : ui.selectedRows.delete(rowId);
      renderData();
      return;
    }
    if (event.target.classList.contains("cell-input")) {
      const columnId = event.target.dataset.columnId;
      commit((state) => { state.rows.find((row) => row.id === rowId).values[columnId] = event.target.value; });
    }
  });
  $("#dataBody").addEventListener("paste", pasteIntoDataGrid);
  $("#dataBody").addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="row-options"]');
    if (button) openRowOptions(button.closest("tr").dataset.rowId);
  });
  let draggedRowId = null;
  $("#dataBody").addEventListener("dragstart", (event) => {
    if (!event.target.classList.contains("row-number")) return event.preventDefault();
    draggedRowId = event.target.closest("tr").dataset.rowId;
    event.dataTransfer.effectAllowed = "move";
  });
  $("#dataBody").addEventListener("dragover", (event) => { if (draggedRowId) event.preventDefault(); });
  $("#dataBody").addEventListener("drop", (event) => {
    event.preventDefault();
    const targetId = event.target.closest("tr")?.dataset.rowId;
    if (!draggedRowId || !targetId || draggedRowId === targetId) return;
    commit((state) => {
      const from = state.rows.findIndex((row) => row.id === draggedRowId);
      const to = state.rows.findIndex((row) => row.id === targetId);
      state.rows.splice(to, 0, state.rows.splice(from, 1)[0]);
    });
    draggedRowId = null;
  });

  $("#clearSelectionButton").addEventListener("click", () => { ui.selectedRows.clear(); renderData(); });
  $("#bulkEditButton").addEventListener("click", openBulkEdit);
  $("#bulkEditColumn").addEventListener("change", updateBulkEditPreview);
  $("#bulkEditOperation").addEventListener("change", renderBulkEditFields);
  $("#applyBulkEditButton").addEventListener("click", applyBulkEdit);
  $("#customizeSelectedButton").addEventListener("click", openSelectedRowOptions);
  $("#resetSelectedLayoutsButton").addEventListener("click", async () => {
    const selected = new Set([...ui.selectedRows].filter((id) => documentState.rows.some((row) => row.id === id)));
    if (!selected.size) return;
    if (!await confirmAction("Reset selected slip customizations?", `${selected.size} row${selected.size === 1 ? "" : "s"} will use the sheet layout and automatic field visibility again.`, "Reset")) return;
    commit((state) => state.rows.forEach((row) => {
      if (!selected.has(row.id)) return;
      delete row.layoutOverride;
      row.overrides = {};
    }));
    toast(`Reset ${selected.size} slip customization${selected.size === 1 ? "" : "s"}`);
  });
  $("#deleteRowsButton").addEventListener("click", async () => {
    const count = ui.selectedRows.size;
    if (!await confirmAction("Delete selected rows?", `${count} row${count === 1 ? "" : "s"} will be removed from this studio.`, "Delete")) return;
    commit((state) => { state.rows = state.rows.filter((row) => !ui.selectedRows.has(row.id)); });
    ui.selectedRows.clear();
    renderAll();
  });
  $("#duplicateRowsButton").addEventListener("click", () => {
    commit((state) => {
      const copies = state.rows.filter((row) => ui.selectedRows.has(row.id)).map((row) => ({ ...clone(row), id: uid("row") }));
      state.rows.push(...copies);
    });
    toast("Selected rows duplicated");
  });
  $("#excludeRowsButton").addEventListener("click", () => commit((state) => state.rows.forEach((row) => { if (ui.selectedRows.has(row.id)) row.disabled = true; })));

  let draggedColumnId = null;
  $("#columnList").addEventListener("dragstart", (event) => {
    const row = event.target.closest(".column-row");
    if (!row) return;
    draggedColumnId = row.dataset.columnId;
    row.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  $("#columnList").addEventListener("dragover", (event) => { event.preventDefault(); const row = event.target.closest(".column-row"); $$(".column-row.drag-over").forEach((item) => item.classList.remove("drag-over")); if (row && row.dataset.columnId !== draggedColumnId) row.classList.add("drag-over"); });
  $("#columnList").addEventListener("drop", (event) => {
    event.preventDefault();
    const target = event.target.closest(".column-row")?.dataset.columnId;
    if (!draggedColumnId || !target || draggedColumnId === target) return;
    commit((state) => {
      const from = state.columns.findIndex((column) => column.id === draggedColumnId);
      const to = state.columns.findIndex((column) => column.id === target);
      state.columns.splice(to, 0, state.columns.splice(from, 1)[0]);
    });
  });
  $("#columnList").addEventListener("dragend", () => { draggedColumnId = null; $$(".column-row").forEach((row) => row.classList.remove("dragging", "drag-over")); });
  $("#columnList").addEventListener("change", async (event) => {
    const row = event.target.closest(".column-row");
    if (!row) return;
    const columnId = row.dataset.columnId;
    if (event.target.classList.contains("column-label-input")) commit((state) => { state.columns.find((column) => column.id === columnId).label = event.target.value.trim() || "Untitled column"; });
    if (event.target.classList.contains("column-group-input")) commit((state) => { state.columns.find((column) => column.id === columnId).group = event.target.value.trim(); });
    if (event.target.classList.contains("column-format-input")) commit((state) => { state.columns.find((column) => column.id === columnId).style = event.target.value; });
    if (event.target.classList.contains("column-type-input")) commit((state) => { state.columns.find((column) => column.id === columnId).type = event.target.value; });
    if (event.target.classList.contains("column-transform-input")) commit((state) => { state.columns.find((column) => column.id === columnId).valueTransform = event.target.value; });
    if (event.target.classList.contains("column-align-input")) commit((state) => { state.columns.find((column) => column.id === columnId).valueAlign = event.target.value; });
    if (event.target.classList.contains("column-visibility-input")) commit((state) => { state.columns.find((column) => column.id === columnId).visibility = event.target.value; });
    if (event.target.classList.contains("column-required-input")) commit((state) => { state.columns.find((column) => column.id === columnId).required = event.target.checked; });
    if (event.target.classList.contains("column-unique-input")) commit((state) => { state.columns.find((column) => column.id === columnId).unique = event.target.checked; });
    if (event.target.classList.contains("column-width-input")) commit((state) => { state.columns.find((column) => column.id === columnId).width = Number(event.target.value); });
  });
  $("#columnList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const columnId = button.closest(".column-row").dataset.columnId;
    if (button.dataset.action === "duplicate-column") {
      commit((state) => {
        const source = state.columns.find((column) => column.id === columnId);
        const copy = { ...clone(source), id: uniqueColumnId(`${source.id}_copy`, state.columns), label: `${source.label} copy` };
        state.columns.splice(state.columns.indexOf(source) + 1, 0, copy);
        state.rows.forEach((row) => { row.values[copy.id] = row.values[source.id] || ""; });
      });
    }
    if (button.dataset.action === "delete-column") {
      if (documentState.columns.length === 1) return toast("A studio needs at least one column.", "error");
      const column = documentState.columns.find((item) => item.id === columnId);
      if (!await confirmAction("Delete column?", `“${column.label}” and its values will be removed.`, "Delete")) return;
      commit((state) => {
        state.columns = state.columns.filter((item) => item.id !== columnId);
        state.rows.forEach((row) => { delete row.values[columnId]; delete row.overrides[columnId]; });
        state.rules = state.rules.filter((rule) => rule.target !== columnId && !rule.conditions.some((condition) => condition.field === columnId));
      });
    }
  });

  $("#ruleList").addEventListener("change", (event) => {
    const card = event.target.closest(".rule-card");
    if (!card) return;
    const ruleId = card.dataset.ruleId;
    const conditionRow = event.target.closest(".condition-row");
    commit((state) => {
      const rule = state.rules.find((item) => item.id === ruleId);
      if (event.target.classList.contains("rule-enabled-input")) rule.enabled = event.target.checked;
      if (event.target.classList.contains("rule-name-input")) rule.name = event.target.value.trim() || actionLabels[rule.action] || "Rule";
      if (event.target.classList.contains("rule-action-input")) { rule.action = event.target.value; rule.name = actionLabels[rule.action]; }
      if (event.target.classList.contains("rule-target-input")) rule.target = event.target.value;
      if (event.target.classList.contains("rule-match-input")) rule.match = event.target.value;
      if (event.target.classList.contains("rule-negate-input")) rule.negate = event.target.checked;
      if (conditionRow) {
        const condition = rule.conditions[Number(conditionRow.dataset.conditionIndex)];
        if (event.target.classList.contains("condition-field")) condition.field = event.target.value;
        if (event.target.classList.contains("condition-operator")) condition.operator = event.target.value;
        if (event.target.classList.contains("condition-value")) condition.value = event.target.value;
      }
    });
  });
  $("#ruleTestRowSelect").addEventListener("change", (event) => { ui.ruleTestRowId = event.target.value; renderRules(); });
  $("#ruleList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const card = button.closest(".rule-card");
    const ruleId = card.dataset.ruleId;
    if (button.dataset.action === "add-condition") commit((state) => state.rules.find((rule) => rule.id === ruleId).conditions.push({ field: state.columns[0]?.id || "", operator: "equals", value: "" }));
    if (button.dataset.action === "delete-condition") {
      const index = Number(button.closest(".condition-row").dataset.conditionIndex);
      commit((state) => {
        const rule = state.rules.find((item) => item.id === ruleId);
        if (rule.conditions.length > 1) rule.conditions.splice(index, 1);
      });
    }
    if (button.dataset.action === "duplicate-rule") commit((state) => { const source = state.rules.find((rule) => rule.id === ruleId); state.rules.splice(state.rules.indexOf(source) + 1, 0, { ...clone(source), id: uid("rule"), name: `${source.name} copy` }); });
    if (button.dataset.action === "delete-rule") commit((state) => { state.rules = state.rules.filter((rule) => rule.id !== ruleId); });
  });
  let draggedRuleId = null;
  $("#ruleList").addEventListener("dragstart", (event) => {
    const card = event.target.closest(".rule-card");
    if (!card || ["INPUT", "SELECT", "BUTTON"].includes(event.target.tagName)) return event.preventDefault();
    draggedRuleId = card.dataset.ruleId;
    card.classList.add("disabled");
    event.dataTransfer.effectAllowed = "move";
  });
  $("#ruleList").addEventListener("dragover", (event) => { if (draggedRuleId) event.preventDefault(); });
  $("#ruleList").addEventListener("drop", (event) => {
    event.preventDefault();
    const targetId = event.target.closest(".rule-card")?.dataset.ruleId;
    if (!draggedRuleId || !targetId || draggedRuleId === targetId) return;
    commit((state) => {
      const from = state.rules.findIndex((rule) => rule.id === draggedRuleId);
      const to = state.rules.findIndex((rule) => rule.id === targetId);
      state.rules.splice(to, 0, state.rules.splice(from, 1)[0]);
    });
    draggedRuleId = null;
  });
  $("#ruleList").addEventListener("dragend", () => { draggedRuleId = null; renderRules(); });
  $("#rulesView").addEventListener("click", (event) => { if (event.target.closest('[data-action="add-rule"]')) addRule(); });
  $("#disableRulesButton").addEventListener("click", () => {
    const enable = !documentState.rules.some((rule) => rule.enabled !== false);
    commit((state) => state.rules.forEach((rule) => { rule.enabled = enable; }));
  });

  $$(".layout-mode").forEach((button) => button.addEventListener("click", () => commit((state) => { state.layout.mode = button.dataset.mode; })));
  const layoutBindings = {
    paperInput: ["paper", String], orientationInput: ["orientation", String], acrossInput: ["across", Number], flowInput: ["flow", String], marginInput: ["margin", Number], gapInput: ["gap", Number], slipHeightInput: ["slipHeight", Number], accentInput: ["accent", String], inkInput: ["ink", String], paperColorInput: ["paperColor", String], borderColorInput: ["borderColor", String], labelSizeInput: ["labelSize", Number], valueSizeInput: ["valueSize", Number], fontInput: ["font", String], labelCaseInput: ["labelCase", String], fieldColumnsInput: ["fieldColumns", Number], labelPositionInput: ["labelPosition", String], valueAlignInput: ["valueAlign", String], labelWidthInput: ["labelWidth", Number], paddingInput: ["padding", Number], radiusInput: ["radius", Number], headerTextInput: ["headerText", String], subtitleInput: ["subtitle", String], footerTextInput: ["footerText", String], headerStyleInput: ["headerStyle", String],
  };
  Object.entries(layoutBindings).forEach(([id, [key, cast]]) => {
    $("#" + id).addEventListener(["slipHeightInput", "accentInput", "inkInput", "paperColorInput", "borderColorInput"].includes(id) ? "input" : "change", (event) => {
      if (["slipHeightInput", "accentInput", "inkInput", "paperColorInput", "borderColorInput"].includes(id)) {
        documentState.layout[key] = cast(event.target.value);
        changed(); renderLayout(); renderPreview();
      } else commit((state) => { state.layout[key] = cast(event.target.value); });
    });
  });
  [["borderInput", "showBorder"], ["cutMarksInput", "cutMarks"], ["footerInput", "footer"], ["fieldLinesInput", "fieldLines"], ["zebraInput", "zebra"], ["showBlankFieldsInput", "showBlankFields"]].forEach(([id, key]) => $("#" + id).addEventListener("change", (event) => commit((state) => { state.layout[key] = event.target.checked; })));
  $("#resetLayoutButton").addEventListener("click", () => commit((state) => { state.layout = clone(defaultLayout); }));
  $("#logoInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg)$/i.test(file.type)) { toast("Choose a PNG or JPEG logo.", "error"); event.target.value = ""; return; }
    if (file.size > 1024 * 1024) { toast("Logo files must be 1 MB or smaller.", "error"); event.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const logoData = safeLogoData(reader.result);
      if (!logoData) { toast("That logo could not be read.", "error"); return; }
      commit((state) => { state.layout.logoData = logoData; });
      event.target.value = "";
      toast("Logo added to the layout");
    };
    reader.onerror = () => toast("That logo could not be read.", "error");
    reader.readAsDataURL(file);
  });
  $("#clearLogoButton").addEventListener("click", () => commit((state) => { state.layout.logoData = ""; }));
  $("#saveLayoutPresetButton").addEventListener("click", saveLayoutPreset);
  $("#layoutPresetName").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveLayoutPreset(); } });
  $("#layoutPresetList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    const presetElement = event.target.closest("[data-preset-id]");
    if (!button || !presetElement) return;
    const presetId = presetElement.dataset.presetId;
    if (button.dataset.action === "apply-preset") {
      const preset = documentState.presets.find((item) => item.id === presetId);
      if (preset) { commit((state) => { state.layout = { ...defaultLayout, ...clone(preset.layout) }; }); toast(`Applied “${preset.name}”`); }
    }
    if (button.dataset.action === "delete-preset") {
      commit((state) => { state.presets = state.presets.filter((item) => item.id !== presetId); });
      toast("Layout removed");
    }
  });
  $("#zoomOutButton").addEventListener("click", () => { ui.zoom = Math.max(.45, ui.zoom - .08); renderPreview(); });
  $("#zoomInButton").addEventListener("click", () => { ui.zoom = Math.min(1.3, ui.zoom + .08); renderPreview(); });
  $("#previewPrevButton").addEventListener("click", () => { ui.previewPage = Math.max(0, ui.previewPage - 1); renderPreview(); });
  $("#previewNextButton").addEventListener("click", () => { ui.previewPage += 1; renderPreview(); });
  $("#paperPreview").addEventListener("click", (event) => { const slip = event.target.closest("[data-preview-row-id]"); if (slip) { ui.selectedPreviewRow = slip.dataset.previewRowId; renderPreview(); } });

  $("#workbookInput").addEventListener("change", (event) => importWorkbook(event.target.files[0]));
  $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); event.currentTarget.classList.add("drag-over"); });
  $("#dropZone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("drag-over"));
  $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("drag-over"); importWorkbook(event.dataTransfer.files[0]); });
  $("#importSheetSelect").addEventListener("change", renderImportMapping);
  $("#importMode").addEventListener("change", updateImportModeNotice);
  $("#mappingList").addEventListener("change", updateImportWarning);
  $("#confirmImportButton").addEventListener("click", confirmImport);
  $("#importDialog").addEventListener("close", resetImportDialog);

  $("#rowIncludedInput").addEventListener("change", (event) => commit((state) => { state.rows.find((row) => row.id === ui.rowOptionsId).disabled = !event.target.checked; }));
  $("#applyRowPresetButton").addEventListener("click", applyRowPreset);
  $("#rowLayoutEnabledInput").addEventListener("change", (event) => {
    commit((state) => {
      const row = state.rows.find((item) => item.id === ui.rowOptionsId);
      if (!row) return;
      if (event.target.checked) row.layoutOverride ||= {};
      else delete row.layoutOverride;
    });
    syncRowLayoutControls();
    const row = documentState.rows.find((item) => item.id === ui.rowOptionsId);
    if (row) syncRowLogoStatus(row);
  });
  $("#rowLogoInput").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg)$/i.test(file.type)) { toast("Choose a PNG or JPEG logo.", "error"); event.target.value = ""; return; }
    if (file.size > 1024 * 1024) { toast("Logo files must be 1 MB or smaller.", "error"); event.target.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const logoData = safeLogoData(reader.result);
      if (!logoData) { toast("That logo could not be read.", "error"); return; }
      setRowLogoData(logoData);
      event.target.value = "";
      toast("Row logo added");
    };
    reader.onerror = () => toast("That logo could not be read.", "error");
    reader.readAsDataURL(file);
  });
  $("#clearRowLogoButton").addEventListener("click", clearRowLogoOverride);
  [["rowModeInput", "mode", String], ["rowFieldColumnsInput", "fieldColumns", Number], ["rowLabelPositionInput", "labelPosition", String], ["rowValueAlignInput", "valueAlign", String], ["rowAccentInput", "accent", String], ["rowPaperColorInput", "paperColor", String], ["rowHeaderTextInput", "headerText", String], ["rowSubtitleInput", "subtitle", String], ["rowFooterTextInput", "footerText", String], ["rowHeaderStyleInput", "headerStyle", String], ["rowFontInput", "font", String], ["rowLabelCaseInput", "labelCase", String], ["rowLabelSizeInput", "labelSize", Number], ["rowValueSizeInput", "valueSize", Number], ["rowLabelWidthInput", "labelWidth", Number], ["rowPaddingInput", "padding", Number], ["rowRadiusInput", "radius", Number], ["rowInkInput", "ink", String], ["rowBorderColorInput", "borderColor", String]].forEach(([id, key, cast]) => $("#" + id).addEventListener("change", (event) => updateRowLayout(key, event.target.value === "" ? "" : cast(event.target.value))));
  $("#rowBorderInput").addEventListener("change", (event) => updateRowLayout("showBorder", event.target.checked));
  $("#rowFieldLinesInput").addEventListener("change", (event) => updateRowLayout("fieldLines", event.target.checked));
  $("#rowZebraInput").addEventListener("change", (event) => updateRowLayout("zebra", event.target.checked));
  let draggedFieldId = null;
  $("#rowFieldOrderList").addEventListener("dragstart", (event) => {
    if (!$("#rowLayoutEnabledInput").checked) return event.preventDefault();
    const item = event.target.closest(".row-order-item");
    if (!item) return;
    draggedFieldId = item.dataset.columnId;
    item.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  $("#rowFieldOrderList").addEventListener("dragover", (event) => {
    if (!draggedFieldId) return;
    event.preventDefault();
    $$(".row-order-item.drag-over", $("#rowFieldOrderList")).forEach((item) => item.classList.remove("drag-over"));
    const target = event.target.closest(".row-order-item");
    if (target && target.dataset.columnId !== draggedFieldId) target.classList.add("drag-over");
  });
  $("#rowFieldOrderList").addEventListener("drop", (event) => {
    event.preventDefault();
    if (!$("#rowLayoutEnabledInput").checked) return;
    const targetId = event.target.closest(".row-order-item")?.dataset.columnId;
    if (!draggedFieldId || !targetId || draggedFieldId === targetId) return;
    const row = documentState.rows.find((item) => item.id === ui.rowOptionsId);
    if (!row) return;
    const order = sortColumnsForRow(documentState.columns, row).map((column) => column.id);
    const from = order.indexOf(draggedFieldId);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    setRowFieldOrder(order);
    draggedFieldId = null;
  });
  $("#rowFieldOrderList").addEventListener("dragend", () => { draggedFieldId = null; $$(".row-order-item").forEach((item) => item.classList.remove("dragging", "drag-over")); });
  $("#resetRowFieldOrderButton").addEventListener("click", () => setRowFieldOrder(documentState.columns.map((column) => column.id)));
  $("#applyRowLayoutToSelectionButton").addEventListener("click", () => {
    const selected = new Set([...ui.selectedRows].filter((id) => documentState.rows.some((row) => row.id === id)));
    const source = documentState.rows.find((row) => row.id === ui.rowOptionsId);
    if (!source || !selected.size) return;
    const override = clone(source.layoutOverride || {});
    const fieldOverrides = clone(source.overrides || {});
    commit((state) => state.rows.forEach((row) => {
      if (!selected.has(row.id)) return;
      row.layoutOverride = clone(override);
      row.overrides = clone(fieldOverrides);
    }));
    syncRowLayoutControls();
    toast(`Copied this customization to ${selected.size} slip${selected.size === 1 ? "" : "s"}`);
  });
  $("#resetRowLayoutButton").addEventListener("click", () => {
    commit((state) => { const row = state.rows.find((item) => item.id === ui.rowOptionsId); if (row) delete row.layoutOverride; });
    openRowOptions(ui.rowOptionsId);
  });
  $("#rowOverrideList").addEventListener("change", (event) => {
    const columnId = event.target.dataset.columnId;
    commit((state) => {
      const overrides = state.rows.find((row) => row.id === ui.rowOptionsId).overrides;
      if (event.target.value === "auto") delete overrides[columnId];
      else overrides[columnId] = event.target.value === "show";
    });
  });

  $("#commandInput").addEventListener("input", () => { ui.commandIndex = 0; renderCommands(); });
  $("#commandInput").addEventListener("keydown", (event) => {
    const actions = filteredCommands();
    if (event.key === "ArrowDown") { event.preventDefault(); ui.commandIndex = (ui.commandIndex + 1) % Math.max(1, actions.length); renderCommands(); }
    if (event.key === "ArrowUp") { event.preventDefault(); ui.commandIndex = (ui.commandIndex - 1 + Math.max(1, actions.length)) % Math.max(1, actions.length); renderCommands(); }
    if (event.key === "Enter") { event.preventDefault(); runCommand(ui.commandIndex); }
  });
  $("#commandList").addEventListener("click", (event) => { const item = event.target.closest("[data-command-index]"); if (item) runCommand(Number(item.dataset.commandIndex)); });
  $$(".modal").forEach((dialog) => dialog.addEventListener("click", (event) => { if (event.target === dialog && dialog.id !== "confirmDialog") dialog.close(); }));

  $("#newProjectButton").addEventListener("click", async () => {
    if (!await confirmAction("Start a new project?", "The current studio is saved locally, but unsaved studio-file changes will be replaced.", "New project")) return;
    pushHistory(); documentState = starterDocument(); ui.selectedRows.clear(); ui.dataPage = 0; changed(); renderAll(); showView("data");
  });

  document.addEventListener("keydown", (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); $("#commandDialog").open ? $("#commandDialog").close() : openCommands(); return; }
    if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (modifier && event.shiftKey && event.key.toLowerCase() === "e") { event.preventDefault(); exportPdf(); return; }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "n") { event.preventDefault(); addRow(); }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "i") { event.preventDefault(); openImport(); }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "d") { event.preventDefault(); showView("data"); }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "l") { event.preventDefault(); showView("layout"); }
  });
}

installEvents();
setPreviewWidth(ui.previewWidth, false);
renderAll();
