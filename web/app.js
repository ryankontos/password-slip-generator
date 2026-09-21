"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = (prefix = "id") => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const PREVIEW_MIN_WIDTH = 360;
const PREVIEW_MAX_WIDTH = 920;
const clampPreviewWidth = (value) => Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, Number(value) || 520));
function storedPreviewWidth() {
  try { return clampPreviewWidth(localStorage.getItem("pss-preview-width")); } catch (_) { return 520; }
}

function loadRecentColors() {
  try { return JSON.parse(localStorage.getItem("pss-recent-colors") || "[]").filter((color) => /^#[0-9a-f]{6}$/i.test(color)).slice(0, 12); } catch (_) { return []; }
}

function saveRecentColors(colors) {
  const clean = [...new Set(colors.filter((color) => /^#[0-9a-f]{6}$/i.test(color)).map((color) => color.toLowerCase()))].slice(0, 12);
  try { localStorage.setItem("pss-recent-colors", JSON.stringify(clean)); } catch (_) {}
  renderRecentColors();
}

function rememberColor(color) {
  saveRecentColors([String(color).toLowerCase(), ...loadRecentColors().filter((item) => item.toLowerCase() !== String(color).toLowerCase())]);
}

function renderRecentColors() {
  const list = $("#recentColorList");
  if (!list) return;
  const colors = loadRecentColors();
  list.innerHTML = colors.length ? colors.map((color) => `<button class="recent-color-swatch" type="button" data-color="${color}" title="${color}" aria-label="Use ${color}" style="background:${color}"></button>`).join("") : `<span class="field-help">Colours you use will appear here.</span>`;
}

const TEMPLATE_STORAGE_KEY = "pss-saved-templates";
const MAX_SAVED_TEMPLATES = 12;

function loadSavedTemplates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.document && Array.isArray(item.document.columns) && Array.isArray(item.document.rows)).slice(0, MAX_SAVED_TEMPLATES) : [];
  } catch (_) {
    return [];
  }
}

function saveSavedTemplates(templates) {
  try {
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates.slice(0, MAX_SAVED_TEMPLATES)));
    return true;
  } catch (_) {
    return false;
  }
}

const defaultLayout = Object.freeze({
  mode: "horizontal",
  paper: "a4",
  orientation: "portrait",
  margin: 10,
  gap: 0,
  slipHeight: 36,
  accent: "#00539b",
  ink: "#151719",
  paperColor: "#ffffff",
  borderColor: "#c9ced4",
  labelSize: 10,
  valueSize: 14,
  font: "Helvetica",
  labelFont: "Helvetica",
  labelCase: "original",
  valueAlign: "left",
  labelWidth: 34,
  stackedColumns: 1,
  padding: 2,
  showBorder: false,
  cutMarks: true,
  footer: true,
  fieldLines: true,
  showBlankFields: true,
  appendDateToFilename: false,
});

function starterDocument() {
  const columns = [
    { id: "name", label: "Name", sourceNames: [], group: "", type: "text", style: "strong", defaultValue: "", visibility: "always" },
    { id: "username", label: "Username", sourceNames: [], group: "", type: "text", style: "standard", defaultValue: "", visibility: "always" },
    { id: "password", label: "Password", sourceNames: [], group: "", type: "password", style: "mono", defaultValue: "", visibility: "always" },
    { id: "recovery", label: "Recovery code", sourceNames: [], group: "", type: "password", style: "mono", defaultValue: "", visibility: "always" },
  ];
  return {
    version: 1,
    name: "Untitled password slips",
    columns,
    rows: [],
    rules: [],
    layout: clone(defaultLayout),
  };
}

const ui = {
  view: "data",
  selectedRows: new Set(),
  search: "",
  history: [],
  future: [],
  zoom: 110,
  dataPage: 0,
  pageSize: 50,
  importData: null,
  rowOptionsId: null,
  ruleTestRowId: "",
  commandIndex: 0,
  saveTimer: null,
  dirty: false,
  previewWidth: storedPreviewWidth(),
  previewUrl: null,
  previewTimer: null,
  previewRevision: 0,
  lastImportSheetName: (() => { try { return localStorage.getItem("pss-last-import-sheet") || ""; } catch (_) { return ""; } })(),
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
  document.rules = Array.isArray(document.rules) ? document.rules.filter((rule) => ["show_field", "hide_field", "hide_slip"].includes(rule?.action)) : [];
  delete document.views;
  delete document.importConfigs;
  document.layout = { ...defaultLayout, ...(document.layout || {}) };
  document.layout.mode = document.layout.mode === "stacked" ? "stacked" : "horizontal";
  document.layout.stackedColumns = Number(document.layout.stackedColumns) === 2 ? 2 : 1;
  document.layout.appendDateToFilename = Boolean(document.layout.appendDateToFilename);
  document.columns.forEach((column, index) => {
    column.id = String(column.id || uniqueColumnId(`column_${index + 1}`, document.columns));
    column.label = String(column.label || `Column ${index + 1}`);
    column.group = String(column.group || "").trim();
    column.type = ["text", "password", "number", "date", "url"].includes(column.type) ? column.type : "text";
    column.style ||= column.type === "password" ? "mono" : "standard";
    column.valueTransform = ["as_entered", "upper", "lower", "title", "mask_last4"].includes(column.valueTransform) ? column.valueTransform : "as_entered";
    column.valueAlign = ["default", "left", "center", "right"].includes(column.valueAlign) ? column.valueAlign : "default";
    column.defaultValue = String(column.defaultValue ?? "");
    column.visibility ||= "always";
    column.sourceNames = [...new Set((Array.isArray(column.sourceNames) ? column.sourceNames : []).map((name) => String(name).trim()).filter(Boolean))];
    delete column.width;
    delete column.required;
    delete column.unique;
  });
  document.rows.forEach((row) => {
    row.id ||= uid("row");
    row.values = row.values && typeof row.values === "object" ? row.values : {};
    row.overrides = row.overrides && typeof row.overrides === "object" ? row.overrides : {};
    delete row.layoutOverride;
    row.hidden = Boolean(row.hidden || row.disabled);
    delete row.disabled;
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
      $("#saveStatus").textContent = "Saved";
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

function filteredRows() {
  const query = ui.search.trim().toLowerCase();
  return documentState.rows.filter((row) => !row.hidden && (!query || rowValuesText(row).includes(query)));
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

function includedRowsFor(state) {
  const hideRules = (state.rules || []).filter((rule) => rule.enabled !== false && rule.action === "hide_slip");
  return (state.rows || []).filter((row) => !row.hidden && !hideRules.some((rule) => ruleMatches(rule, row.values || {})));
}

function includedRows() {
  return includedRowsFor(documentState);
}

function printScopeRows() {
  const printable = includedRows();
  return ui.selectedRows.size ? printable.filter((row) => ui.selectedRows.has(row.id)) : printable;
}

function printScopeSource() {
  const source = clone(documentState);
  source.rows = printScopeRows().map((row) => clone(row));
  return source;
}

function rowHiddenReason(row) {
  if (row.hidden) return "Hidden manually";
  const rule = documentState.rules.find((item) => item.enabled !== false && item.action === "hide_slip" && ruleMatches(item, row.values));
  return rule ? `Hidden by rule: ${rule.name || "Unnamed rule"}` : "";
}

function renderAll() {
  $("#documentName").value = documentState.name;
  renderData();
  renderColumns();
  renderRules();
  renderLayout();
  renderRecentColors();
  schedulePdfPreview();
  $("#columnCount").textContent = documentState.columns.length;
  $("#ruleCount").textContent = documentState.rules.length;
  $("#undoButton").disabled = !ui.history.length;
  $("#redoButton").disabled = !ui.future.length;
}

function renderData() {
  [...ui.selectedRows].forEach((id) => { if (!documentState.rows.some((row) => row.id === id && !row.hidden)) ui.selectedRows.delete(id); });
  const allRows = filteredRows();
  const pageCount = Math.max(1, Math.ceil(allRows.length / ui.pageSize));
  ui.dataPage = Math.min(ui.dataPage, pageCount - 1);
  const rows = allRows.slice(ui.dataPage * ui.pageSize, (ui.dataPage + 1) * ui.pageSize);
  $("#rowSearch").value = ui.search;
  $("#dataSummary").textContent = `${documentState.rows.length} row${documentState.rows.length === 1 ? "" : "s"} · ${documentState.columns.length} field${documentState.columns.length === 1 ? "" : "s"}`;
  $("#dataHead").innerHTML = `<tr><th><input id="selectAllRows" type="checkbox" aria-label="Select all filtered rows" ${allRows.length && allRows.every((row) => ui.selectedRows.has(row.id)) ? "checked" : ""}></th><th class="row-number-head">#</th>${documentState.columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}<th class="row-menu-head"></th></tr>`;
  $("#dataBody").innerHTML = rows.map((row) => {
    const originalIndex = documentState.rows.indexOf(row) + 1;
    const customized = Object.keys(row.overrides || {}).length > 0;
    const hiddenReason = rowHiddenReason(row);
    return `<tr data-row-id="${row.id}" class="${ui.selectedRows.has(row.id) ? "selected" : ""} ${customized ? "customized" : ""} ${hiddenReason ? "excluded" : ""}" title="${escapeHtml(hiddenReason)}">
      <td class="select-cell"><input class="row-select" type="checkbox" ${ui.selectedRows.has(row.id) ? "checked" : ""} aria-label="Select row ${originalIndex}"></td>
      <td class="row-number" draggable="true">⠿ ${originalIndex}${hiddenReason ? " ⊘" : ""}${customized ? " ✦" : ""}</td>
      ${documentState.columns.map((column) => `<td><input type="text" class="cell-input ${column.style === "mono" || column.type === "password" ? "password-cell" : ""}" data-column-id="${column.id}" value="${escapeHtml(row.values[column.id] || "")}" aria-label="${escapeHtml(column.label)}, row ${originalIndex}"></td>`).join("")}
      <td class="row-menu"><button class="row-menu-button" data-action="row-options" title="Row options" aria-label="Row ${originalIndex} options">•••</button></td>
    </tr>`;
  }).join("");
  $("#dataEmpty").hidden = Boolean(allRows.length);
  const hidden = documentState.rows.filter((row) => row.hidden).length;
  const visibleTotal = documentState.rows.length - hidden;
  const rowText = ui.search ? `${allRows.length} of ${visibleTotal} rows` : `${allRows.length} rows`;
  $("#visibleRowCount").textContent = hidden ? `${rowText} · ${hidden} hidden` : rowText;
  $("#visibleRowCount").classList.toggle("warning-text", hidden > 0);
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
    <div class="column-field"><button class="drag-handle" title="Drag to reorder" aria-label="Drag ${escapeHtml(column.label)}">⠿</button><div class="column-name-group"><input class="column-label-input" value="${escapeHtml(column.label)}" aria-label="Field label"><select class="column-type-input" aria-label="${escapeHtml(column.label)} type"><option value="text" ${column.type === "text" ? "selected" : ""}>Text</option><option value="password" ${column.type === "password" ? "selected" : ""}>Password</option><option value="number" ${column.type === "number" ? "selected" : ""}>Number</option><option value="date" ${column.type === "date" ? "selected" : ""}>Date / time</option><option value="url" ${column.type === "url" ? "selected" : ""}>Link / URL</option></select><input class="column-default-input" type="text" value="${escapeHtml(column.defaultValue)}" placeholder="Default on new row" aria-label="${escapeHtml(column.label)} default value" autocomplete="off"></div></div>
    <div class="column-appearance"><select class="column-format-input" aria-label="${escapeHtml(column.label)} format"><option value="standard" ${column.style === "standard" ? "selected" : ""}>Standard</option><option value="strong" ${column.style === "strong" ? "selected" : ""}>Bold</option><option value="mono" ${column.style === "mono" ? "selected" : ""}>Monospace</option></select><details class="field-options"><summary>More options</summary><div><label>Text<select class="column-transform-input" aria-label="${escapeHtml(column.label)} value transform"><option value="as_entered" ${column.valueTransform === "as_entered" ? "selected" : ""}>As entered</option><option value="upper" ${column.valueTransform === "upper" ? "selected" : ""}>UPPERCASE</option><option value="lower" ${column.valueTransform === "lower" ? "selected" : ""}>lowercase</option><option value="title" ${column.valueTransform === "title" ? "selected" : ""}>Title Case</option><option value="mask_last4" ${column.valueTransform === "mask_last4" ? "selected" : ""}>Mask · last 4</option></select></label><label>Alignment<select class="column-align-input" aria-label="${escapeHtml(column.label)} value alignment"><option value="default" ${column.valueAlign === "default" ? "selected" : ""}>Default</option><option value="left" ${column.valueAlign === "left" ? "selected" : ""}>Left</option><option value="center" ${column.valueAlign === "center" ? "selected" : ""}>Centre</option><option value="right" ${column.valueAlign === "right" ? "selected" : ""}>Right</option></select></label></div></details></div>
    <select class="column-visibility-input" aria-label="${escapeHtml(column.label)} visibility"><option value="always" ${column.visibility === "always" ? "selected" : ""}>Always</option><option value="nonempty" ${column.visibility === "nonempty" ? "selected" : ""}>Only with a value</option><option value="never" ${column.visibility === "never" ? "selected" : ""}>Hidden by default</option></select>
    <div class="column-actions"><button class="icon-button small" data-action="duplicate-column" title="Duplicate field">⧉</button><button class="icon-button small" data-action="delete-column" title="Delete field">×</button></div>
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
  hide_slip: "Hide entire slip",
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
    testSelect.innerHTML = `<option value="">No row selected</option>${testRows.map((row, index) => { const label = documentState.columns.map((column) => String(row.values?.[column.id] ?? "").trim()).find(Boolean) || `Row ${index + 1}`; return `<option value="${escapeHtml(row.id)}">${escapeHtml(`Row ${index + 1} · ${label}`)}${row.hidden ? " · hidden" : ""}</option>`; }).join("")}`;
    testSelect.value = ui.ruleTestRowId;
    testSelect.disabled = !testRows.length;
  }
  const selectedTestRow = testRows.find((row) => row.id === ui.ruleTestRowId);
  const selectedHiddenReason = selectedTestRow ? rowHiddenReason(selectedTestRow) : "";
  $("#ruleTestStatus").textContent = selectedTestRow ? (selectedHiddenReason || "Printable · rule matches are shown on each card") : (testRows.length ? "Select a row to inspect its rule matches" : "Add or import rows to test rules");
  $("#ruleSummary").textContent = `${active} active rule${active === 1 ? "" : "s"} · ${documentState.rules.length} total`;
  $("#disableRulesButton").textContent = active ? "Disable all" : "Enable all";
  $("#ruleList").innerHTML = documentState.rules.map((rule, index) => { const matching = documentState.rows.filter((row) => ruleMatches(rule, row.values)).length; const testMatch = selectedTestRow && rule.enabled !== false ? ruleMatches(rule, selectedTestRow.values) : null; const testLabel = selectedTestRow ? (rule.enabled === false ? "Disabled" : testMatch ? "Matches test row" : "No match") : ""; return `<article class="rule-card ${rule.enabled === false ? "disabled" : ""}" data-rule-id="${rule.id}" draggable="true">
    <header class="rule-header"><span class="rule-number">${index + 1}</span><input class="rule-name-input" value="${escapeHtml(rule.name || actionLabels[rule.action] || "Rule")}" aria-label="Rule name"><span class="rule-match-count">${matching} matching</span>${testLabel ? `<span class="rule-test-chip ${testMatch ? "pass" : "fail"}">${escapeHtml(testLabel)}</span>` : ""}<label class="rule-enabled"><input class="rule-enabled-input" type="checkbox" ${rule.enabled !== false ? "checked" : ""}> Active</label><button class="icon-button small" data-action="duplicate-rule" title="Duplicate rule">⧉</button><button class="icon-button small" data-action="delete-rule" title="Delete rule">×</button></header>
    <div class="rule-body">
      <div class="rule-action-row"><span>Then</span><select class="rule-action-input">${actionOptions(rule.action)}</select>${rule.action === "hide_slip" ? `<span class="rule-target-label">Entire slip</span>` : `<select class="rule-target-input">${columnOptions(rule.target)}</select>`}</div>
      <div class="conditions">
        ${(rule.conditions || []).map((condition, conditionIndex) => `<div class="condition-row" data-condition-index="${conditionIndex}"><span class="condition-join">${conditionIndex ? (rule.match === "any" ? "OR" : "AND") : "If"}</span><select class="condition-field">${columnOptions(condition.field)}</select><select class="condition-operator">${operatorOptions(condition.operator)}</select><input class="condition-value" value="${escapeHtml(condition.value || "")}" placeholder="Value" ${["empty", "not_empty"].includes(condition.operator) ? "hidden" : ""}><button class="condition-delete" data-action="delete-condition" title="Remove condition">×</button></div>`).join("")}
        <div class="condition-footer"><button class="text-button" data-action="add-condition">＋ Add condition</button><label class="match-control">Match<select class="rule-match-input"><option value="all" ${rule.match !== "any" ? "selected" : ""}>all conditions</option><option value="any" ${rule.match === "any" ? "selected" : ""}>any condition</option></select></label><label class="negate-control"><input class="rule-negate-input" type="checkbox" ${rule.negate ? "checked" : ""}> Not</label></div>
      </div>
    </div>
  </article>`; }).join("");
  $("#rulesEmpty").hidden = Boolean(documentState.rules.length);
}

// The preview is the real server-rendered PDF. The browser's PDF viewer handles
// pagination and crisp scaling; the studio only controls when it is regenerated.
function renderLayout() {
  const layout = documentState.layout;
  $$(".layout-mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === layout.mode));
  const bindings = {
    paperInput: layout.paper,
    orientationInput: layout.orientation,
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
  };
  Object.entries(bindings).forEach(([id, value]) => { const control = $("#" + id); if (control) control.value = value; });
  $("#borderInput").checked = layout.showBorder;
  $("#cutMarksInput").checked = layout.cutMarks;
  $("#footerInput").checked = layout.footer;
  $("#fieldLinesInput").checked = layout.fieldLines;
  $("#filenameDateInput").checked = Boolean(layout.appendDateToFilename);
  $("#stackedColumnsInput").value = String(layout.stackedColumns || 1);
  $("#stackedColumnsControl").hidden = layout.mode !== "stacked";
  $("#slipHeightOutput").textContent = `${layout.slipHeight} mm`;
  const pageHeight = layout.orientation === "landscape" ? (layout.paper === "letter" ? 215.9 : 210) : (layout.paper === "letter" ? 279.4 : 297);
  const usable = pageHeight - (2 * Number(layout.margin || 0)) - (layout.footer ? 7 : 0);
  const perPage = Math.max(0, Math.floor((usable + Number(layout.gap || 0)) / (Number(layout.slipHeight || 1) + Number(layout.gap || 0))));
  $("#sheetCapacity").textContent = `${perPage} slip${perPage === 1 ? "" : "s"} per page · full sheet width`;
}

function applyPreviewZoom() {
  $("#zoomLabel").textContent = `${ui.zoom}%`;
  if (ui.previewUrl) $("#pdfPreviewFrame").src = `${ui.previewUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=${ui.zoom}`;
}

function clearPdfPreview(message = "Add or import rows to preview the PDF.") {
  ui.previewRevision += 1;
  if (ui.previewUrl) URL.revokeObjectURL(ui.previewUrl);
  ui.previewUrl = null;
  const frame = $("#pdfPreviewFrame");
  frame.hidden = true;
  frame.removeAttribute("src");
  $("#previewPlaceholder").hidden = false;
  $("#previewPlaceholder").textContent = message;
}

function schedulePdfPreview(immediate = false) {
  clearTimeout(ui.previewTimer);
  if (!documentState.rows.length || !documentState.columns.length) {
    clearPdfPreview();
    $("#previewStats").textContent = documentState.rows.length ? "No columns" : "No rows";
    return;
  }
  const printableCount = printScopeRows().length;
  if (!printableCount) {
    clearPdfPreview("No printable slips. Show a hidden row or change the hide-slip rules to render a PDF.");
    $("#previewStats").textContent = `0 printable · ${documentState.rows.length} stored`;
    return;
  }
  $("#previewStats").textContent = "Rendering…";
  ui.previewTimer = setTimeout(renderPdfPreview, immediate ? 0 : 400);
}

async function renderPdfPreview() {
  const revision = ++ui.previewRevision;
  const renderAttempt = async (attempt) => {
    if (revision !== ui.previewRevision) return;
    try {
      const response = await fetch("/api/pdf", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: printScopeSource() }),
      });
      if (!response.ok) {
        let message = "The PDF preview could not be rendered.";
        try { message = (await response.json()).error || message; } catch (_) {}
        throw new Error(message);
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/pdf")) throw new Error("The preview server returned an invalid PDF response.");
      const blob = await response.blob();
      if (revision !== ui.previewRevision) return;
      const nextUrl = URL.createObjectURL(blob);
      const previousUrl = ui.previewUrl;
      ui.previewUrl = nextUrl;
      const frame = $("#pdfPreviewFrame");
      frame.src = `${nextUrl}#toolbar=0&navpanes=0&scrollbar=0&zoom=${ui.zoom}`;
      frame.hidden = false;
      $("#previewPlaceholder").hidden = true;
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      const printableCount = printScopeRows().length;
      const scopeLabel = ui.selectedRows.size ? `${ui.selectedRows.size} selected · ` : "";
      $("#previewStats").textContent = `${scopeLabel}${printableCount} printable · ${documentState.layout.mode}`;
      $("#zoomLabel").textContent = `${ui.zoom}%`;
    } catch (error) {
      if (revision !== ui.previewRevision) return;
      if (attempt < 2) {
        setTimeout(() => renderAttempt(attempt + 1), 250 * (attempt + 1));
        return;
      }
      if (ui.previewUrl) {
        $("#previewStats").textContent = "Preview update failed · showing last render";
        return;
      }
      clearPdfPreview(`PDF preview error: ${error.message}`);
      $("#previewStats").textContent = "Preview unavailable";
    }
  };
  renderAttempt(0);
}

function renderPreview() {
  schedulePdfPreview();
}

function addRow() {
  const row = { id: uid("row"), values: Object.fromEntries(documentState.columns.map((column) => [column.id, column.defaultValue || ""])), hidden: false, overrides: {} };
  commit((state) => state.rows.push(row));
  showView("data");
  requestAnimationFrame(() => $(`[data-row-id="${row.id}"] .cell-input`)?.focus());
}

function addColumn(label = "New field") {
  const id = uniqueColumnId(label);
  commit((state) => {
    state.columns.push({ id, label, sourceNames: [], group: "", type: "text", style: "standard", valueAlign: "default", defaultValue: "", visibility: "always" });
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
  $("#rowPrintableInput").checked = !row.hidden;
  $("#rowOverrideList").innerHTML = documentState.columns.map((column) => `<label class="override-row"><strong>${escapeHtml(column.label)}</strong><select data-column-id="${column.id}"><option value="auto" ${row.overrides[column.id] == null ? "selected" : ""}>Automatic</option><option value="show" ${row.overrides[column.id] === true ? "selected" : ""}>Always show</option><option value="hide" ${row.overrides[column.id] === false ? "selected" : ""}>Always hide</option></select></label>`).join("");
  if (!$("#rowOptionsDialog").open) $("#rowOptionsDialog").showModal();
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
      const row = { id: uid("row"), values: Object.fromEntries(state.columns.map((column) => [column.id, column.defaultValue || ""])), hidden: false, overrides: {} };
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

function currentDateStamp() {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
}

function pdfDownloadFilename(source, filenameSuffix = "") {
  const dateSuffix = source?.layout?.appendDateToFilename ? `-${currentDateStamp()}` : "";
  return `${safeFilename(source?.name)}${filenameSuffix}${dateSuffix}.pdf`;
}

async function exportPdf(source = documentState, filenameSuffix = "", triggerButton = null) {
  if (!Array.isArray(source.rows) || !source.rows.length) { toast("There are no data rows to export. Import a sheet or add a row first.", "error"); return; }
  if (!includedRowsFor(source).length) { toast("Every row is hidden by its row setting or a hide-slip rule.", "error"); return; }
  if (!Array.isArray(source.columns) || !source.columns.length) { toast("Add at least one field before exporting.", "error"); return; }
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
    downloadBlob(await response.blob(), pdfDownloadFilename(source, filenameSuffix));
    toast("PDF exported");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function exportSelectedRows() {
  await exportCurrentScope();
}

async function exportCurrentScope(triggerButton = null) {
  const rows = printScopeRows();
  if (!rows.length) { toast(ui.selectedRows.size ? "No selected rows can be printed." : "There are no printable rows to export.", "error"); return; }
  await exportPdf(printScopeSource(), ui.selectedRows.size ? "-selected" : "", triggerButton);
}

function downloadWorkspace() {
  const workspace = { format: "password-slip-studio-workspace", version: 1, document: documentState, recentColors: loadRecentColors() };
  const blob = new Blob([JSON.stringify(workspace, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${safeFilename(documentState.name)}.password-slip-workspace`);
  toast("Workspace saved");
}

function studioFilePayload(parsed) {
  const format = parsed?.format || "legacy";
  const document = format === "password-slip-studio-workspace" || format === "password-slip-studio-template" ? parsed.document : parsed;
  if (!document || !Array.isArray(document.columns) || !Array.isArray(document.rows)) throw new Error("This file is not a valid Password Slip Studio document.");
  return { document, recentColors: Array.isArray(parsed?.recentColors) ? parsed.recentColors : null, format };
}

function applyOpenedDocument(incoming, recentColors, message) {
  pushHistory();
  documentState = normaliseDocument(incoming);
  if (Array.isArray(recentColors)) saveRecentColors(recentColors);
  ui.selectedRows.clear();
  ui.search = "";
  ui.dataPage = 0;
  changed();
  renderAll();
  showView("data");
  toast(message);
}

async function loadWorkspaceFile(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const payload = studioFilePayload(parsed);
    if (payload.format === "password-slip-studio-template") throw new Error("This is a template. Open it from Templates.");
    applyOpenedDocument(payload.document, payload.recentColors, "Workspace opened");
  } catch (error) {
    toast(error.message || "The workspace could not be opened.", "error");
  }
}

function templateRecordFromDocument(document, name, includeData) {
  const templateDocument = clone(document);
  templateDocument.name = name;
  if (!includeData) templateDocument.rows = [];
  const existing = loadSavedTemplates().find((item) => String(item.name || "").trim().toLowerCase() === name.trim().toLowerCase());
  return { id: existing?.id || uid("template"), name, savedAt: new Date().toISOString(), includeData, document: normaliseDocument(templateDocument), recentColors: loadRecentColors() };
}

function templateFilePayload(record) {
  return { format: "password-slip-studio-template", version: 1, name: record.name, includeData: record.includeData, document: record.document, recentColors: record.recentColors || [] };
}

function downloadTemplateRecord(record) {
  const blob = new Blob([JSON.stringify(templateFilePayload(record), null, 2)], { type: "application/json" });
  downloadBlob(blob, `${safeFilename(record.name)}.password-slip-template`);
}

function storeTemplateRecord(record) {
  const templates = loadSavedTemplates().filter((item) => item.id !== record.id && String(item.name || "").trim().toLowerCase() !== record.name.trim().toLowerCase());
  return saveSavedTemplates([record, ...templates]);
}

function formatTemplateDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved template" : `Saved ${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
}

function renderTemplateList() {
  const list = $("#templateList");
  if (!list) return;
  const templates = loadSavedTemplates();
  list.innerHTML = templates.length ? templates.map((template) => {
    const rowCount = template.document.rows.length;
    const dataLabel = template.includeData ? `${rowCount} row${rowCount === 1 ? "" : "s"} included` : "No data included";
    return `<article class="template-item" data-template-id="${escapeHtml(template.id)}"><div class="template-item-info"><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(formatTemplateDate(template.savedAt))} · ${escapeHtml(dataLabel)}</small></div><div class="template-item-actions"><button class="button quiet compact" type="button" data-template-action="open">Open</button><button class="button quiet compact" type="button" data-template-action="download">File</button><button class="button quiet compact danger" type="button" data-template-action="delete">Delete</button></div></article>`;
  }).join("") : `<div class="template-empty">No saved templates yet. Save the current fields and layout above.</div>`;
}

function openTemplates() {
  $("#templateNameInput").value = documentState.name;
  $("#templateIncludeDataInput").checked = false;
  renderTemplateList();
  $("#templatesDialog").showModal();
  requestAnimationFrame(() => $("#templateNameInput").focus());
}

function saveTemplateFromDialog() {
  const name = $("#templateNameInput").value.trim() || documentState.name || "Password slip template";
  const record = templateRecordFromDocument(documentState, name, $("#templateIncludeDataInput").checked);
  const stored = storeTemplateRecord(record);
  downloadTemplateRecord(record);
  renderTemplateList();
  toast(stored ? `Template “${name}” saved` : `Template file downloaded; browser storage is full`, stored ? "" : "error");
}

function openTemplateRecord(record) {
  if (!record?.document) return;
  applyOpenedDocument(record.document, record.recentColors, `Template “${record.name || record.document.name || "Untitled"}” opened`);
  $("#templatesDialog").close();
}

async function loadTemplateFile(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const payload = studioFilePayload(parsed);
    if (payload.format !== "password-slip-studio-template") throw new Error("Choose a .password-slip-template file.");
    const record = { id: uid("template"), name: String(parsed.name || payload.document.name || file.name.replace(/\.[^.]+$/, "")), savedAt: new Date().toISOString(), includeData: parsed.includeData !== false, document: normaliseDocument(payload.document), recentColors: payload.recentColors || [] };
    storeTemplateRecord(record);
    openTemplateRecord(record);
  } catch (error) {
    toast(error.message || "The template could not be opened.", "error");
  } finally {
    $("#loadTemplateInput").value = "";
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
  $("#importRowSelectionMode").value = "all";
  $("#importRowVisibility").value = "printable";
  $("#importRowNumbers").value = "";
  $("#importHiddenRowNumbers").value = "";
  $("#importColumnMode").value = "replace";
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
    if (!Array.isArray(payload.sheets) || !payload.sheets.length) throw new Error("The workbook has no readable, visible worksheets.");
    ui.importData = payload;
    $("#importSheetSelect").innerHTML = payload.sheets.map((sheet, index) => `<option value="${index}">${escapeHtml(sheet.name)} · ${sheet.rows.length} rows</option>`).join("");
    const preferredSheet = ui.lastImportSheetName;
    const preferredIndex = payload.sheets.findIndex((sheet) => normaliseImportName(sheet.name) === normaliseImportName(preferredSheet));
    if (preferredIndex >= 0) $("#importSheetSelect").value = String(preferredIndex);
    rememberImportSheet();
    $("#importChoose").hidden = true;
    $("#importMap").hidden = false;
    $("#confirmImportButton").hidden = false;
    $("#importStepLabel").textContent = "Choose rows and columns";
    renderImportMapping();
  } catch (error) {
    $("#importMeta").textContent = error.message || "The workbook could not be imported.";
    toast(error.message || "The workbook could not be imported.", "error");
  }
}

function normaliseImportName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rememberImportSheet() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect")?.value) || 0];
  if (!sheet) return;
  ui.lastImportSheetName = sheet.name;
  try { localStorage.setItem("pss-last-import-sheet", sheet.name); } catch (_) {}
}

function guessedMapping(header) {
  const normal = normaliseImportName(header);
  const match = documentState.columns.find((column) => [column.id, column.label, ...(column.sourceNames || [])].some((name) => normaliseImportName(name) === normal));
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
  return "text";
}

function parseImportRowNumbers(value) {
  const numbers = new Set();
  const invalid = [];
  const tokens = String(value || "").split(/[\s,]+/).map((token) => token.trim()).filter(Boolean);
  tokens.forEach((token) => {
    const single = /^(\d+)$/.exec(token);
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (single) {
      const number = Number(single[1]);
      if (number >= 2) numbers.add(number); else invalid.push(token);
      return;
    }
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start < 2 || end < start || end - start > 20000) {
        invalid.push(token);
        return;
      }
      for (let number = start; number <= end; number += 1) numbers.add(number);
      return;
    }
    invalid.push(token);
  });
  return { numbers: [...numbers].sort((left, right) => left - right), invalid };
}

function selectedImportRows(sheet) {
  const entries = (sheet?.rows || []).map((values, index) => ({
    values,
    index,
    rowNumber: Number(sheet.rowNumbers?.[index] || index + 2),
  }));
  if ($("#importRowSelectionMode")?.value !== "manual") return { entries, requested: [], invalid: [], missing: [] };
  const parsed = parseImportRowNumbers($("#importRowNumbers")?.value);
  const available = new Map(entries.map((entry) => [entry.rowNumber, entry]));
  const selected = parsed.numbers.map((number) => available.get(number)).filter(Boolean);
  const missing = parsed.numbers.filter((number) => !available.has(number));
  return { entries: selected, requested: parsed.numbers, invalid: parsed.invalid, missing };
}

function hiddenImportRows(sheet, selectedEntries = selectedImportRows(sheet).entries) {
  const parsed = parseImportRowNumbers($("#importHiddenRowNumbers")?.value);
  const available = new Set((sheet?.rowNumbers || []).map(Number));
  const selected = new Set(selectedEntries.map((entry) => entry.rowNumber));
  return {
    numbers: new Set(parsed.numbers.filter((number) => selected.has(number))),
    invalid: parsed.invalid,
    missing: parsed.numbers.filter((number) => !available.has(number)),
    unselected: parsed.numbers.filter((number) => available.has(number) && !selected.has(number)),
  };
}

function updateImportRowSelectionControls() {
  const manual = $("#importRowSelectionMode")?.value === "manual";
  $("#importRowNumbersWrap").hidden = !manual;
}

function importTargetOptions(selected) {
  return `<option value="__create__" ${selected === "__create__" ? "selected" : ""}>Create new field</option>${documentState.columns.map((column) => `<option value="${escapeHtml(column.id)}" ${column.id === selected ? "selected" : ""}>Add to “${escapeHtml(column.label)}”</option>`).join("")}`;
}

function updateImportMappingControls() {
  const overwrite = $("#importColumnMode").value === "replace";
  $$(".mapping-row", $("#mappingList")).forEach((row) => {
    const include = row.querySelector(".mapping-include")?.checked;
    const select = row.querySelector(".mapping-select");
    const newName = row.querySelector(".mapping-new-name");
    if (!select || !newName) return;
    if (overwrite && include && select.value !== "__create__") {
      row.dataset.mergeTarget = select.value;
      select.value = "__create__";
      if (!newName.value) newName.value = row.getAttribute("data-source-header") || row.querySelector(".mapping-source")?.textContent?.trim() || "";
    } else if (!overwrite && select.value === "__create__" && row.dataset.mergeTarget) {
      select.value = row.dataset.mergeTarget;
      delete row.dataset.mergeTarget;
    }
    select.disabled = !include || overwrite;
    newName.disabled = !include || select.value !== "__create__";
    row.classList.toggle("mapping-included", Boolean(include));
  });
}

function currentImportMappings() {
  return $$(".mapping-row", $("#mappingList")).map((row, sourceIndex) => {
    const include = Boolean(row.querySelector(".mapping-include")?.checked);
    return {
      sourceIndex: Number(row.dataset.sourceIndex ?? sourceIndex),
      target: include ? row.querySelector(".mapping-select")?.value || "__create__" : "__skip__",
      header: row.dataset.sourceHeader || "",
      include,
      newName: row.querySelector(".mapping-new-name")?.value.trim() || "",
    };
  });
}

function updateMappingSummary() {
  const mappings = currentImportMappings();
  const mapped = mappings.filter((item) => item.include && item.target !== "__skip__");
  const created = mapped.filter((item) => item.target === "__create__").length;
  const existing = mapped.length - created;
  const skipped = mappings.length - mapped.length;
  const duplicateTargets = [...new Set(mapped.filter((item) => item.target !== "__create__").map((item) => item.target).filter((target, index, list) => list.indexOf(target) !== index))];
  const names = mapped.filter((item) => item.target === "__create__").map((item) => (item.newName || item.header).trim().toLowerCase()).filter(Boolean);
  const duplicateNames = [...new Set(names.filter((name, index, list) => list.indexOf(name) !== index))];
  $("#mappingSummary").textContent = `${mapped.length} included · ${existing} existing field${existing === 1 ? "" : "s"} · ${created} new field${created === 1 ? "" : "s"} · ${skipped} skipped${duplicateTargets.length || duplicateNames.length ? ` · ${duplicateTargets.length + duplicateNames.length} duplicate name${duplicateTargets.length + duplicateNames.length === 1 ? "" : "s"}` : ""}`;
  return { duplicateTargets, duplicateNames };
}

function updateImportWarning() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  const duplicates = updateMappingSummary();
  const mappings = currentImportMappings();
  const selection = selectedImportRows(sheet);
  const hiddenSelection = hiddenImportRows(sheet, selection.entries);
  const warnings = [];
  if (sheet?.truncated) warnings.push("This sheet was limited to the first 20,000 non-empty rows.");
  if ($("#importRowSelectionMode").value === "manual") {
    if (selection.invalid.length) warnings.push(`Invalid row number${selection.invalid.length === 1 ? "" : "s"}: ${selection.invalid.join(", ")}. Use numbers and ranges such as 2, 5, 10-15.`);
    if (selection.missing.length) warnings.push(`${selection.missing.length} requested row${selection.missing.length === 1 ? " is" : "s are"} not available and will be skipped (hidden rows are excluded).`);
    if (!selection.entries.length && !selection.invalid.length && !selection.missing.length) warnings.push("Enter at least one spreadsheet row number.");
  }
  if (hiddenSelection.invalid.length) warnings.push(`Invalid hidden row number${hiddenSelection.invalid.length === 1 ? "" : "s"}: ${hiddenSelection.invalid.join(", ")}.`);
  if (hiddenSelection.missing.length) warnings.push(`${hiddenSelection.missing.length} hidden row selection${hiddenSelection.missing.length === 1 ? " is" : "s are"} not available.`);
  if (hiddenSelection.unselected.length) warnings.push(`${hiddenSelection.unselected.length} hidden row selection${hiddenSelection.unselected.length === 1 ? " is" : "s are"} outside the rows being imported.`);
  if (!mappings.some((mapping) => mapping.include && mapping.target !== "__skip__")) warnings.push("Select at least one source column to import.");
  if (duplicates.duplicateTargets.length) warnings.push("Two or more sheet columns map to the same studio field. Remap one of them before importing.");
  if (duplicates.duplicateNames.length) warnings.push("Two or more new columns use the same name. Give each new column a unique name.");
  if ($("#importColumnMode").value === "replace") warnings.push("Overwrite mode will remove the current columns and rules when you import.");
  $("#importWarning").hidden = !warnings.length;
  $("#importWarning").textContent = warnings.join(" ");
}

function renderImportMapping() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  if (!sheet) return;
  updateImportRowSelectionControls();
  const selectedRows = selectedImportRows(sheet).entries;
  $("#mappingList").innerHTML = sheet.headers.map((header, index) => {
    const guessed = guessedMapping(header);
    const target = guessed;
    const include = target !== "__create__";
    const matchedLabel = documentState.columns.find((column) => column.id === target)?.label;
    const newName = target === "__create__" ? header : (matchedLabel || header);
    return `<div class="mapping-row" data-source-index="${index}" data-source-header="${escapeHtml(header)}"><input class="mapping-include" type="checkbox" aria-label="Include ${escapeHtml(header)}" ${include ? "checked" : ""}><span class="mapping-source">${escapeHtml(header)}</span><select class="mapping-select" aria-label="How to import ${escapeHtml(header)}">${importTargetOptions(target)}</select><input class="mapping-new-name" type="text" value="${escapeHtml(newName)}" placeholder="New column name" aria-label="New name for ${escapeHtml(header)}"><span class="mapping-sample">${escapeHtml(selectedRows.find((entry) => entry.values[index])?.values[index] || sheet.rows.find((row) => row[index])?.[index] || "—")}</span></div>`;
  }).join("");
  $("#importMeta").textContent = `${ui.importData.filename} · ${sheet.rows.length} non-empty rows · ${selectedRows.length} selected`;
  updateImportMappingControls();
  updateImportWarning();
  updateImportModeNotice();
}

function updateImportModeNotice() {
  updateImportRowSelectionControls();
  const replace = $("#importMode").value === "replace";
  const overwriteColumns = $("#importColumnMode").value === "replace";
  const hiddenRows = $("#importRowVisibility").value === "hidden";
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  const selection = selectedImportRows(sheet);
  const hiddenSelection = hiddenImportRows(sheet, selection.entries);
  const incoming = selection.entries.length;
  const available = sheet?.rows?.length || 0;
  const selectedNotice = $("#importRowSelectionMode").value === "manual"
    ? `${incoming} of ${available} selected spreadsheet rows`
    : `${incoming} non-empty spreadsheet rows`;
  if (ui.importData && sheet) $("#importMeta").textContent = `${ui.importData.filename} · ${available} non-empty rows · ${incoming} selected`;
  const rowNotice = replace
    ? `Rows: all ${documentState.rows.length} existing rows will be removed and replaced by ${selectedNotice}.`
    : `Rows: ${selectedNotice} will be added after the current ${documentState.rows.length} rows.`;
  const individuallyHidden = hiddenSelection.numbers.size;
  const visibilityNotice = hiddenRows
    ? "Imported rows will be hidden from preview and PDF but remain available in the studio and rule tester."
    : individuallyHidden
      ? `${individuallyHidden} selected row${individuallyHidden === 1 ? "" : "s"} will be hidden; the rest will be printable unless a hide-slip rule matches.`
      : "Imported rows will be printable unless a hide-slip rule matches.";
  const columnNotice = overwriteColumns
    ? "Fields: checked spreadsheet fields will replace the current fields. Recognised names stay selected and keep their display names."
    : "Fields: checked spreadsheet fields will be mapped or added; unchecked fields stay out of the studio.";
  $("#importModeNotice").textContent = `${rowNotice} ${visibilityNotice} ${columnNotice}`;
  $("#confirmImportButton").textContent = replace ? "Replace rows" : "Import rows";
  updateImportMappingControls();
  updateImportWarning();
}

function confirmImport() {
  const sheet = ui.importData?.sheets[Number($("#importSheetSelect").value) || 0];
  if (!sheet) return;
  const selection = selectedImportRows(sheet);
  if (selection.invalid.length) {
    toast("Fix the invalid spreadsheet row numbers before importing.", "error");
    return;
  }
  if (!selection.entries.length) {
    toast("Select at least one spreadsheet row to import.", "error");
    return;
  }
  const replaceRows = $("#importMode").value === "replace";
  const overwriteColumns = $("#importColumnMode").value === "replace";
  const importHidden = $("#importRowVisibility").value === "hidden";
  const hiddenSelection = hiddenImportRows(sheet, selection.entries);
  if (hiddenSelection.invalid.length || hiddenSelection.missing.length || hiddenSelection.unselected.length) {
    toast("Fix the hidden spreadsheet row numbers before importing.", "error");
    return;
  }
  const mappings = currentImportMappings().filter((mapping) => mapping.include && mapping.target !== "__skip__");
  if (!mappings.length) {
    toast("Check at least one sheet column to import.", "error");
    return;
  }
  const duplicateIssues = updateMappingSummary();
  if (duplicateIssues.duplicateTargets.length || duplicateIssues.duplicateNames.length) {
    toast("Resolve duplicate field mappings or new names before importing.", "error");
    return;
  }
  if (overwriteColumns && mappings.some((mapping) => mapping.target !== "__create__")) {
    toast("Overwrite mode creates a new column for each checked source column.", "error");
    return;
  }
  commit((state) => {
    const targetIds = new Map();
    const nextColumns = overwriteColumns ? [] : state.columns;
    const sourceRows = selection.entries.map((entry) => entry.values);
    mappings.forEach((mapping) => {
      if (mapping.target === "__create__") {
        const label = mapping.newName || mapping.header;
        const id = uniqueColumnId(label, nextColumns);
        const type = inferImportedColumnType(mapping.header, sourceRows.map((row) => row[mapping.sourceIndex]));
        nextColumns.push({ id, label, sourceNames: [mapping.header], group: "", type, style: type === "password" ? "mono" : "standard", valueAlign: "default", defaultValue: "", visibility: "always" });
        targetIds.set(mapping.sourceIndex, id);
      } else {
        const targetColumn = nextColumns.find((column) => column.id === mapping.target);
        if (targetColumn) targetColumn.sourceNames = [...new Set([...(targetColumn.sourceNames || []), mapping.header])];
        targetIds.set(mapping.sourceIndex, mapping.target);
      }
    });
    if (overwriteColumns) {
      state.columns = nextColumns;
      const validColumns = new Set(state.columns.map((column) => column.id));
      state.rules = state.rules.filter((rule) => (rule.action === "hide_slip" || validColumns.has(rule.target)) && Array.isArray(rule.conditions) && rule.conditions.every((condition) => validColumns.has(condition.field)));
      state.rows.forEach((row) => { row.values = Object.fromEntries(state.columns.map((column) => [column.id, ""])); row.overrides = {}; });
    } else {
      state.columns = nextColumns;
      state.rows.forEach((row) => { state.columns.forEach((column) => { row.values[column.id] ??= ""; }); });
    }
    const imported = selection.entries.map((entry) => {
      const source = entry.values;
      const values = Object.fromEntries(state.columns.map((column) => [column.id, ""]));
      targetIds.forEach((target, sourceIndex) => { values[target] = String(source[sourceIndex] ?? ""); });
      return { id: uid("row"), values, hidden: importHidden || hiddenSelection.numbers.has(entry.rowNumber), overrides: {} };
    });
    if (replaceRows) state.rows = imported;
    else state.rows.push(...imported);
  });
  ui.dataPage = 0;
  $("#importDialog").close();
  showView("data");
  const hiddenCount = importHidden ? selection.entries.length : hiddenSelection.numbers.size;
  toast(`${selection.entries.length} row${selection.entries.length === 1 ? "" : "s"} ${replaceRows ? "replaced the current data" : "imported"}${hiddenCount ? ` · ${hiddenCount} hidden` : ""} · ${mappings.length} field${mappings.length === 1 ? "" : "s"} included`);
}

function resetWorkspaceUi() {
  ui.selectedRows.clear();
  ui.search = "";
  ui.dataPage = 0;
  ui.ruleTestRowId = "";
}

async function clearAllData() {
  if (!documentState.rows.length) { toast("There is no data to clear"); return; }
  if (!await confirmAction("Clear all data?", `Remove all ${documentState.rows.length} rows? Fields, rules and layout will stay.`, "Clear data")) return;
  commit((state) => { state.rows = []; });
  resetWorkspaceUi();
  renderAll();
  showView("data");
  toast("All data cleared");
}

async function resetEverything() {
  if (!await confirmAction("Reset everything?", "Remove all data, fields, rules and layout changes? This cannot be undone.", "Reset everything")) return;
  documentState = starterDocument();
  ui.history = [];
  ui.future = [];
  resetWorkspaceUi();
  try { localStorage.removeItem("password-slip-studio-document"); } catch (_) {}
  changed();
  renderAll();
  showView("data");
  toast("Studio reset");
}

function commandActions() {
  return [
    { icon: "⇧", label: "Import spreadsheet", detail: "XLSX, XLSM or CSV", run: openImport },
    { icon: "＋", label: "Add row", detail: "Manual entry · ⌘↵", run: addRow },
    { icon: "⫶", label: "Add field", detail: "Define a value shown on slips", run: () => addColumn() },
    { icon: "⌁", label: "Add rule", detail: "Conditional visibility or row filter", run: addRule },
    { icon: "▦", label: "Go to Data", detail: "D", run: () => showView("data") },
    { icon: "⫶", label: "Go to Fields", detail: "", run: () => showView("columns") },
    { icon: "⌁", label: "Go to Rules", detail: "", run: () => showView("rules") },
    { icon: "▤", label: "Go to Layout", detail: "L", run: () => showView("layout") },
    { icon: "↓", label: "Export PDF", detail: "Selected rows or all · ⇧⌘E", run: exportCurrentScope },
    { icon: "↓", label: "Export CSV", detail: "Data", run: exportCsv },
    { icon: "⧉", label: "Copy visible rows", detail: "Data", run: copyVisibleRows },
    { icon: "✎", label: "Bulk edit selected rows", detail: "Selection", run: openBulkEdit },
    { icon: "◇", label: "Save workspace", detail: "File · ⌘S", run: downloadWorkspace },
    { icon: "◇", label: "Open workspace", detail: "File · ⌘O", run: () => $("#loadWorkspaceInput").click() },
    { icon: "◇", label: "Save template", detail: "Fields, rules and layout · ⇧⌘T", run: openTemplates },
    { icon: "◇", label: "Open templates", detail: "Saved or file", run: openTemplates },
    { icon: "⌫", label: "Clear all data", detail: "Keep fields and layout · ⇧⌘⌫", run: clearAllData },
    { icon: "↺", label: "Reset everything", detail: "Start fresh", run: resetEverything },
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

function closeMoreMenu() {
  $("#moreMenu").hidden = true;
  $("#moreButton").setAttribute("aria-expanded", "false");
}

function toggleMoreMenu() {
  const menu = $("#moreMenu");
  menu.hidden = !menu.hidden;
  $("#moreButton").setAttribute("aria-expanded", String(!menu.hidden));
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
  ["#addRowButton", "#appendRowButton"].forEach((selector) => $(selector).addEventListener("click", addRow));
  $("#dataImportButton").addEventListener("click", openImport);
  $("#addColumnButton").addEventListener("click", () => addColumn());
  $("#addRuleButton").addEventListener("click", addRule);
  $("#commandButton").addEventListener("click", openCommands);
  $("#moreButton").addEventListener("click", (event) => { event.stopPropagation(); toggleMoreMenu(); });
  $("#moreMenu").addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.closest("button")) requestAnimationFrame(closeMoreMenu);
  });
  document.addEventListener("click", closeMoreMenu);
  $("#exportPdfButton").addEventListener("click", () => exportCurrentScope());
  $("#quickResetButton").addEventListener("click", resetEverything);
  $("#exportSelectedButton").addEventListener("click", exportSelectedRows);
  $("#exportCsvButton").addEventListener("click", exportCsv);
  $("#downloadWorkspaceButton").addEventListener("click", downloadWorkspace);
  $("#loadWorkspaceButton").addEventListener("click", () => $("#loadWorkspaceInput").click());
  $("#loadWorkspaceInput").addEventListener("change", (event) => loadWorkspaceFile(event.target.files[0]));
  $("#saveTemplateMenuButton").addEventListener("click", openTemplates);
  $("#openTemplatesButton").addEventListener("click", openTemplates);
  $("#saveTemplateButton").addEventListener("click", saveTemplateFromDialog);
  $("#openTemplateFileButton").addEventListener("click", () => $("#loadTemplateInput").click());
  $("#loadTemplateInput").addEventListener("change", (event) => loadTemplateFile(event.target.files[0]));
  $("#clearDataButton").addEventListener("click", clearAllData);
  $("#clearDataTabButton").addEventListener("click", clearAllData);
  $("#themeButton").addEventListener("click", toggleTheme);
  installPreviewResize();
  $("#undoButton").addEventListener("click", undo);
  $("#redoButton").addEventListener("click", redo);
  $("#rowSearch").addEventListener("input", (event) => {
    ui.search = event.target.value;
    ui.dataPage = 0;
    ui.selectedRows.clear();
    renderData();
    schedulePdfPreview();
  });
  $("#documentName").addEventListener("input", (event) => {
    documentState.name = event.target.value.trimStart() || "Untitled password slips";
    changed();
  });
  $("#pageSizeInput").addEventListener("change", (event) => { ui.pageSize = Math.max(1, Number(event.target.value) || 50); ui.dataPage = 0; renderData(); });
  $("#dataPrevButton").addEventListener("click", () => { ui.dataPage = Math.max(0, ui.dataPage - 1); renderData(); });
  $("#dataNextButton").addEventListener("click", () => { ui.dataPage += 1; renderData(); });
  $("#dataView").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "add-row") addRow();
    if (action === "import") openImport();
  });

  $("#dataHead").addEventListener("change", (event) => {
    if (event.target.id !== "selectAllRows") return;
    filteredRows().forEach((row) => event.target.checked ? ui.selectedRows.add(row.id) : ui.selectedRows.delete(row.id));
    renderData();
    schedulePdfPreview();
  });

  $("#dataBody").addEventListener("change", (event) => {
    const rowElement = event.target.closest("tr[data-row-id]");
    if (!rowElement) return;
    const rowId = rowElement.dataset.rowId;
    if (event.target.classList.contains("row-select")) {
      event.target.checked ? ui.selectedRows.add(rowId) : ui.selectedRows.delete(rowId);
      renderData();
      schedulePdfPreview();
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

  $("#clearSelectionButton").addEventListener("click", () => { ui.selectedRows.clear(); renderData(); schedulePdfPreview(); });
  $("#bulkEditButton").addEventListener("click", openBulkEdit);
  $("#bulkEditColumn").addEventListener("change", updateBulkEditPreview);
  $("#bulkEditOperation").addEventListener("change", renderBulkEditFields);
  $("#applyBulkEditButton").addEventListener("click", applyBulkEdit);
  $("#templateList").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-template-action]")?.dataset.templateAction;
    const item = event.target.closest("[data-template-id]");
    if (!action || !item) return;
    const record = loadSavedTemplates().find((template) => template.id === item.dataset.templateId);
    if (!record) return;
    if (action === "open") openTemplateRecord(record);
    if (action === "download") downloadTemplateRecord(record);
    if (action === "delete" && await confirmAction("Delete template?", `Remove “${record.name}” from saved templates?`, "Delete template")) {
      saveSavedTemplates(loadSavedTemplates().filter((template) => template.id !== record.id));
      renderTemplateList();
      toast("Template deleted");
    }
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
  $("#hideRowsButton").addEventListener("click", () => {
    commit((state) => state.rows.forEach((row) => { if (ui.selectedRows.has(row.id)) row.hidden = true; }));
    toast(`${ui.selectedRows.size} slip${ui.selectedRows.size === 1 ? "" : "s"} hidden`);
  });
  $("#showRowsButton").addEventListener("click", () => {
    commit((state) => state.rows.forEach((row) => { if (ui.selectedRows.has(row.id)) row.hidden = false; }));
    toast(`${ui.selectedRows.size} slip${ui.selectedRows.size === 1 ? "" : "s"} made printable`);
  });

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
  });
  $("#columnList").addEventListener("input", (event) => {
    if (!event.target.classList.contains("column-default-input")) return;
    const columnId = event.target.closest(".column-row")?.dataset.columnId;
    const column = documentState.columns.find((item) => item.id === columnId);
    if (!column || column.defaultValue === event.target.value) return;
    column.defaultValue = event.target.value;
    changed();
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
      if (documentState.columns.length === 1) return toast("A studio needs at least one field.", "error");
      const column = documentState.columns.find((item) => item.id === columnId);
      if (!await confirmAction("Delete field?", `“${column.label}” and its values will be removed.`, "Delete")) return;
      commit((state) => {
        state.columns = state.columns.filter((item) => item.id !== columnId);
        state.rows.forEach((row) => { delete row.values[columnId]; delete row.overrides[columnId]; });
        state.rules = state.rules.filter((rule) => (rule.action === "hide_slip" || rule.target !== columnId) && !rule.conditions.some((condition) => condition.field === columnId));
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
  $("#stackedColumnsInput").addEventListener("change", (event) => commit((state) => { state.layout.stackedColumns = Number(event.target.value) === 2 ? 2 : 1; }));
  const layoutBindings = {
    paperInput: ["paper", String], orientationInput: ["orientation", String], marginInput: ["margin", Number], gapInput: ["gap", Number], slipHeightInput: ["slipHeight", Number], accentInput: ["accent", String], inkInput: ["ink", String], paperColorInput: ["paperColor", String], borderColorInput: ["borderColor", String], labelSizeInput: ["labelSize", Number], valueSizeInput: ["valueSize", Number], fontInput: ["font", String], labelFontInput: ["labelFont", String], labelCaseInput: ["labelCase", String],
  };
  Object.entries(layoutBindings).forEach(([id, [key, cast]]) => {
    $("#" + id).addEventListener(["slipHeightInput", "accentInput", "inkInput", "paperColorInput", "borderColorInput"].includes(id) ? "input" : "change", (event) => {
      if (["slipHeightInput", "accentInput", "inkInput", "paperColorInput", "borderColorInput"].includes(id)) {
        documentState.layout[key] = cast(event.target.value);
        changed(); renderLayout(); schedulePdfPreview();
      } else commit((state) => { state.layout[key] = cast(event.target.value); });
    });
  });
  $("#filenameDateInput").addEventListener("change", (event) => commit((state) => { state.layout.appendDateToFilename = event.target.checked; }));
  ["accentInput", "inkInput", "paperColorInput", "borderColorInput"].forEach((id) => $("#" + id).addEventListener("change", (event) => rememberColor(event.target.value)));
  $("#recentColorList").addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-color]");
    if (!swatch) return;
    const key = $("#recentColorTarget").value;
    commit((state) => { state.layout[key] = swatch.dataset.color; });
  });
  [["borderInput", "showBorder"], ["cutMarksInput", "cutMarks"], ["footerInput", "footer"], ["fieldLinesInput", "fieldLines"]].forEach(([id, key]) => $("#" + id).addEventListener("change", (event) => commit((state) => { state.layout[key] = event.target.checked; })));
  $("#resetLayoutButton").addEventListener("click", () => commit((state) => { state.layout = clone(defaultLayout); }));
  $("#zoomOutButton").addEventListener("click", () => { ui.zoom = Math.max(50, ui.zoom - 25); applyPreviewZoom(); });
  $("#zoomInButton").addEventListener("click", () => { ui.zoom = Math.min(300, ui.zoom + 25); applyPreviewZoom(); });
  $("#refreshPreviewButton").addEventListener("click", () => schedulePdfPreview(true));

  $("#workbookInput").addEventListener("change", (event) => importWorkbook(event.target.files[0]));
  $("#dropZone").addEventListener("dragover", (event) => { event.preventDefault(); event.currentTarget.classList.add("drag-over"); });
  $("#dropZone").addEventListener("dragleave", (event) => event.currentTarget.classList.remove("drag-over"));
  $("#dropZone").addEventListener("drop", (event) => { event.preventDefault(); event.currentTarget.classList.remove("drag-over"); importWorkbook(event.dataTransfer.files[0]); });
  $("#importSheetSelect").addEventListener("change", () => { rememberImportSheet(); renderImportMapping(); });
  $("#importMode").addEventListener("change", updateImportModeNotice);
  $("#importColumnMode").addEventListener("change", updateImportModeNotice);
  $("#importRowVisibility").addEventListener("change", updateImportModeNotice);
  $("#importRowSelectionMode").addEventListener("change", () => { updateImportRowSelectionControls(); updateImportModeNotice(); });
  $("#importRowNumbers").addEventListener("input", () => { updateImportModeNotice(); });
  $("#importHiddenRowNumbers").addEventListener("input", () => { updateImportModeNotice(); });
  $("#includeAllColumnsButton").addEventListener("click", () => {
    $$(".mapping-include", $("#mappingList")).forEach((input) => { input.checked = true; });
    updateImportMappingControls();
    updateImportWarning();
  });
  $("#clearAllColumnsButton").addEventListener("click", () => {
    $$(".mapping-include", $("#mappingList")).forEach((input) => { input.checked = false; });
    updateImportMappingControls();
    updateImportWarning();
  });
  $("#mappingList").addEventListener("change", (event) => {
    if (event.target.classList.contains("mapping-select") || event.target.classList.contains("mapping-include")) updateImportMappingControls();
    updateImportWarning();
  });
  $("#mappingList").addEventListener("input", (event) => {
    if (!event.target.classList.contains("mapping-new-name")) return;
    updateImportWarning();
  });
  $("#confirmImportButton").addEventListener("click", confirmImport);
  $("#importDialog").addEventListener("close", resetImportDialog);

  $("#rowPrintableInput").addEventListener("change", (event) => {
    commit((state) => {
      const row = state.rows.find((item) => item.id === ui.rowOptionsId);
      if (row) row.hidden = !event.target.checked;
    });
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

  document.addEventListener("keydown", (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); $("#commandDialog").open ? $("#commandDialog").close() : openCommands(); return; }
    if (modifier && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (modifier && event.shiftKey && event.key.toLowerCase() === "e") { event.preventDefault(); exportCurrentScope(); return; }
    if (modifier && !event.shiftKey && event.key.toLowerCase() === "s" && !typing && !$("dialog[open]")) { event.preventDefault(); downloadWorkspace(); return; }
    if (modifier && !event.shiftKey && event.key.toLowerCase() === "o" && !typing && !$("dialog[open]")) { event.preventDefault(); $("#loadWorkspaceInput").click(); return; }
    if (modifier && event.shiftKey && event.key.toLowerCase() === "t" && !$("dialog[open]")) { event.preventDefault(); openTemplates(); return; }
    if (modifier && event.key === "Enter" && !$("dialog[open]")) { event.preventDefault(); addRow(); return; }
    if (modifier && event.shiftKey && event.key === "Backspace" && !$("dialog[open]")) { event.preventDefault(); clearAllData(); return; }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "n") { event.preventDefault(); addRow(); }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "i") { event.preventDefault(); openImport(); }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "d") { event.preventDefault(); showView("data"); }
    if (!modifier && !typing && !$("dialog[open]") && event.key.toLowerCase() === "l") { event.preventDefault(); showView("layout"); }
  });
}

installEvents();
setPreviewWidth(ui.previewWidth, false);
renderAll();
