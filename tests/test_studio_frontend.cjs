const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Exercise the actual editor functions without starting the browser UI.
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const editorSource = source.slice(0, source.indexOf('window.addEventListener("pagehide"'));

function editor() {
  const storage = new Map();
  const elements = new Map();
  const callbacks = new Map();
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      activeElement: null,
      querySelector: (selector) => {
        if (!elements.has(selector)) elements.set(selector, { disabled: false, textContent: "", classList: { toggle() {} } });
        return elements.get(selector);
      },
      querySelectorAll: () => [],
    },
    setTimeout: (callback) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
    clearTimeout: (id) => callbacks.delete(id),
    requestAnimationFrame: (callback) => callback(),
    Blob,
  });
  vm.runInContext(editorSource, context);
  vm.runInContext(`
    renderData = () => {};
    renderAll = () => {};
    schedulePdfPreview = () => {};
    updateExportAvailability = () => {};
    showView = () => {};
    currentWorkspacePreferences = () => ({});
    documentState.rows = [{ id: "one", values: {name: "Original"}, overrides: {}, hidden: false }];
  `, context);
  return {
    context, storage, elements,
    run: (code) => vm.runInContext(code, context),
  };
}

function cell(value = "Original") {
  const rowElement = { dataset: { rowId: "one" }, classList: { toggle() {} } };
  return { value, dataset: { columnId: "name" }, closest: () => rowElement, blur() {} };
}

test("typing saves a cell before blur and keeps one undo step for the edit", () => {
  const app = editor();
  app.context.input = cell("First keystroke");
  app.run("updateGridCellValue(input)");
  app.context.input.value = "Final value";
  app.run("updateGridCellValue(input); flushPersistence()");
  const saved = JSON.parse(app.storage.get("password-slip-studio-document"));
  assert.equal(saved.rows[0].values.name, "Final value");
  assert.equal(app.run("ui.history.length"), 1);
  app.run("undo()");
  assert.equal(app.run("documentState.rows[0].values.name"), "Original");
});

test("an empty new browser is not mistaken for unsaved work", () => {
  const app = editor();
  app.run("documentState = loadDocument()");
  assert.equal(app.run("hasMeaningfulLocalDocument()"), false);
});

test("Escape restores and autosaves the value from the start of the edit", () => {
  const app = editor();
  app.context.input = cell("Changed");
  app.run("updateGridCellValue(input); flushPersistence(); cancelGridCellEdit(input); flushPersistence()");
  assert.equal(app.context.input.value, "Original");
  assert.equal(app.run("ui.history.length"), 0);
  assert.equal(JSON.parse(app.storage.get("password-slip-studio-document")).rows[0].values.name, "Original");
});

test("leaving and editing a cell again creates a separate undo step", () => {
  const app = editor();
  app.context.input = cell("First edit");
  app.run("updateGridCellValue(input); commitGridCellValue(input)");
  app.context.input.value = "Second edit";
  app.run("updateGridCellValue(input)");
  assert.equal(app.run("ui.history.length"), 2);
  app.run("undo()");
  assert.equal(app.run("documentState.rows[0].values.name"), "First edit");
});

test("keyboard navigation opens the page containing the next cell", () => {
  const app = editor();
  app.run(`
    documentState.rows = Array.from({length: 30}, (_, index) => ({id: "row" + index, values: {name: "Person " + index}, hidden: false}));
    ui.pageSize = 25;
    focusGridCell("row25", "name");
  `);
  assert.equal(app.run("ui.dataPage"), 1);
  app.run('focusGridCell("row24", "name")');
  assert.equal(app.run("ui.dataPage"), 0);
});

test("Tab at the end adds one row but Enter never adds a row", () => {
  const app = editor();
  app.run('documentState.columns = [{id: "name", label: "Name", type: "text"}]');
  app.context.input = cell();
  app.run("moveGridCell(input, 1, 0)");
  assert.equal(app.run("documentState.rows.length"), 1);
  assert.equal(app.run("ui.history.length"), 0);
  app.run("moveGridCell(input, 0, 1)");
  assert.equal(app.run("documentState.rows.length"), 2);
  assert.equal(app.run("ui.history.length"), 1);
});

test("reordering visible rows preserves hidden and off-page items", () => {
  const app = editor();
  app.run(`
    documentState.rows = ["a", "hidden", "b", "c", "offpage"].map(id => ({id, values: {}, hidden: id === "hidden"}));
    reorderVisibleItems("rows", ["c", "a", "b"]);
  `);
  assert.equal(app.run('documentState.rows.map(row => row.id).join(",")'), "c,hidden,a,b,offpage");
  app.run('reorderVisibleItems("rows", ["a", "a"]); reorderVisibleItems("rows", ["missing"])');
  assert.equal(app.run("ui.history.length"), 1);
  app.run("undo()");
  assert.equal(app.run('documentState.rows.map(row => row.id).join(",")'), "a,hidden,b,c,offpage");
});

test("adding past the first page reveals the new row and clears the old print selection", () => {
  const app = editor();
  app.run(`
    documentState.rows = Array.from({length: 27}, (_, index) => ({id: "row" + index, values: {}, hidden: index < 2}));
    ui.pageSize = 25;
    ui.selectedRows.add("row3");
    addRow();
  `);
  assert.equal(app.run("ui.dataPage"), 1);
  assert.equal(app.run("ui.selectedRows.size"), 0);
  assert.equal(app.run("documentState.rows.length"), 28);
});

test("canceling a reused confirmation dialog cannot repeat a previous approval", async () => {
  const app = editor();
  let closed;
  const dialog = {
    returnValue: "confirm",
    showModal() {},
    addEventListener: (event, listener) => { if (event === "close") closed = listener; },
  };
  app.elements.set("#confirmDialog", dialog);
  const result = app.run('confirmAction("Delete rows?", "Remove rows?", "Delete")');
  assert.equal(dialog.returnValue, "cancel");
  closed();
  assert.equal(await result, false);
});
