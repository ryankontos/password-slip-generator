const { test, expect } = require("@playwright/test");

const pageErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.waitForFunction(() => ui.sessionReady);
  await page.waitForFunction(() => librarySync.ready && !librarySync.initializing && !librarySync.saving);
  await expect(page.locator("#saveStatus")).toHaveText("Saved");
  await page.evaluate(async () => {
    flushPersistence();
    await waitForSessionAutosave();
    documentState = normaliseDocument(starterDocument());
    resetWorkspaceUi();
    await startNewServerSession();
    renderAll();
    showView("data");
  });
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page), "Unexpected browser errors").toEqual([]);
});

test("templates and palettes are shared across browsers without being replaced by older sessions", async ({ page, browser }) => {
  const oldSession = await page.evaluate(() => ui.sessionId);
  await page.locator("#addRowButton").click();
  await page.locator('#dataBody input[data-column-id="name"]').fill("Saved data");
  await page.locator("#openTemplatesHeaderButton").click();
  await page.locator("#templateNameInput").fill("Shared fields only");
  await page.locator("#saveTemplateButton").click();
  await expect(page.locator(".template-item").filter({ hasText: "Shared fields only" })).toContainText("No data included");
  await expect(page.locator("#saveTemplateButton")).toBeEnabled();
  await page.locator("#templateNameInput").fill("Shared with data");
  await page.locator("#templateIncludeDataInput").check();
  await page.locator("#saveTemplateButton").click();
  await expect(page.locator("#saveTemplateButton")).toBeEnabled();
  await page.screenshot({ path: "test-results/templates-shared-library.png" });
  await page.keyboard.press("Escape");
  await page.locator('[data-view="layout"]').click();
  await page.locator("#accentInput").fill("#123456");
  await page.locator("#paletteNameInput").fill("Shared colours");
  await page.locator("#savePaletteButton").click();
  await expect.poll(() => page.evaluate(() => librarySync.pending.length)).toBe(0);
  const other = await browser.newContext();
  try {
    const resumed = await other.newPage();
    await resumed.goto("/");
    await resumed.waitForFunction(() => librarySync.ready && !librarySync.saving);
    await resumed.locator("#openTemplatesHeaderButton").click();
    const fields = resumed.locator(".template-item").filter({ hasText: "Shared fields only" });
    await expect(fields).toBeVisible();
    await fields.getByRole("button", { name: "Open", exact: true }).click();
    await expect(resumed.locator("#dataBody tr")).toHaveCount(0);
    await resumed.locator("#openTemplatesHeaderButton").click();
    await resumed.locator(".template-item").filter({ hasText: "Shared with data" }).getByRole("button", { name: "Open", exact: true }).click();
    await expect(resumed.locator('#dataBody input[data-column-id="name"]')).toHaveValue("Saved data");
    await resumed.locator('[data-view="layout"]').click();
    await expect(resumed.locator("#paletteSelect option").filter({ hasText: "Shared colours" })).toHaveCount(1);
    await resumed.evaluate(async id => applySessionWorkspace(await sessionRequest("/" + id)), oldSession);
    expect(await resumed.evaluate(() => loadColorPalettes().some(item => item.name === "Shared colours"))).toBe(true);
  } finally { await other.close(); }
});

test("older browser templates migrate once and deleted templates do not reappear", async ({ page, browser }) => {
  const legacy = await browser.newContext();
  await legacy.addInitScript(() => {
    if (localStorage.getItem("migration-fixture")) return;
    localStorage.setItem("migration-fixture", "1");
    localStorage.setItem("pss-saved-templates", JSON.stringify([{ id: "legacy-template", name: "Legacy setup", savedAt: "2026-01-01", includeData: false,
      document: { name: "Legacy setup", columns: [{ id: "legacy", label: "Legacy field", type: "text" }], rows: [] } }]));
  });
  try {
    const migrated = await legacy.newPage();
    await migrated.goto("/");
    await migrated.waitForFunction(() => librarySync.ready && !librarySync.saving);
    await page.evaluate(() => pollSharedLibrary());
    await page.locator("#openTemplatesHeaderButton").click();
    await page.locator(".template-item").filter({ hasText: "Legacy setup" }).getByRole("button", { name: "Delete", exact: true }).click();
    await page.locator("#confirmDialog").getByRole("button", { name: "Delete template", exact: true }).click();
    await expect(page.locator(".template-item").filter({ hasText: "Legacy setup" })).toHaveCount(0);
    await migrated.reload();
    await migrated.waitForFunction(() => librarySync.ready && !librarySync.saving);
    expect(await migrated.evaluate(() => loadSavedTemplates().some(item => item.id === "legacy-template"))).toBe(false);
  } finally { await legacy.close(); }
});

test("a template save survives a service outage, reload, and reconnection", async ({ page, browser }) => {
  await page.route("**/api/library", route => route.abort());
  await page.locator("#openTemplatesHeaderButton").click();
  await page.locator("#templateNameInput").fill("Reconnect setup");
  await page.locator("#saveTemplateButton").click();
  await expect(page.locator(".template-item").filter({ hasText: "Reconnect setup" })).toContainText("Waiting to sync");
  await expect(page.locator("#saveTemplateButton")).toBeEnabled();
  await page.reload();
  await page.waitForFunction(() => ui.sessionReady);
  expect(await page.evaluate(() => librarySync.pending.some(item => item.record?.name === "Reconnect setup"))).toBe(true);
  await page.unroute("**/api/library");
  await page.evaluate(() => pollSharedLibrary());
  await expect.poll(() => page.evaluate(() => librarySync.pending.length)).toBe(0);
  const other = await browser.newContext();
  try {
    const resumed = await other.newPage();
    await resumed.goto("/");
    await resumed.waitForFunction(() => librarySync.ready && !librarySync.saving);
    await resumed.locator("#openTemplatesHeaderButton").click();
    await expect(resumed.locator(".template-item").filter({ hasText: "Reconnect setup" })).toBeVisible();
  } finally { await other.close(); }
});

test("replacing a template from a stale browser keeps both configurations", async ({ page, browser }) => {
  await page.locator("#openTemplatesHeaderButton").click();
  await page.locator("#templateNameInput").fill("Conflicting setup");
  await page.locator("#saveTemplateButton").click();
  await expect(page.locator("#saveTemplateButton")).toBeEnabled();
  await page.keyboard.press("Escape");
  const other = await browser.newContext();
  try {
    const stale = await other.newPage();
    await stale.goto("/");
    await stale.waitForFunction(() => librarySync.ready && !librarySync.saving);
    const olderLibrary = await stale.evaluate(() => librarySync.snapshot);
    await stale.route("**/api/library", route => route.request().method() === "GET" ? route.fulfill({ json: olderLibrary }) : route.continue());
    for (const [editor, name] of [[page, "Current field"], [stale, "My field"]]) {
      await editor.locator('[data-view="columns"]').click();
      await editor.locator('[data-column-id="name"] .column-label-input').fill(name);
      await editor.locator("#openTemplatesHeaderButton").click();
      await editor.locator("#templateNameInput").fill("Conflicting setup");
      await editor.locator("#saveTemplateButton").click();
      await editor.locator("#confirmDialog").getByRole("button", { name: "Replace template", exact: true }).click();
      await expect(editor.locator("#saveTemplateButton")).toBeEnabled();
    }
    const records = await stale.evaluate(() => loadSavedTemplates().filter(item => item.name.startsWith("Conflicting setup")));
    expect(records).toHaveLength(2);
    expect(records.map(item => item.document.columns[0].label).sort()).toEqual(["Current field", "My field"]);
    await expect(stale.locator(".template-item").filter({ hasText: "Conflicting setup (copy)" })).toBeVisible();
  } finally { await other.close(); }
});

test("separate tabs can queue saves during an outage without losing either", async ({ page }) => {
  const peer = await page.context().newPage();
  try {
    await peer.goto("/");
    await peer.waitForFunction(() => librarySync.ready && !librarySync.saving);
    for (const [editor, name] of [[page, "Offline tab one"], [peer, "Offline tab two"]]) {
      await editor.route("**/api/library", route => route.abort());
      await editor.locator("#openTemplatesHeaderButton").click();
      await editor.locator("#templateNameInput").fill(name);
      await editor.locator("#saveTemplateButton").click();
      await expect(editor.locator("#saveTemplateButton")).toBeEnabled();
    }
    await page.unroute("**/api/library");
    await peer.unroute("**/api/library");
    await page.evaluate(() => pollSharedLibrary());
    await peer.evaluate(() => pollSharedLibrary());
    const names = await page.evaluate(() => loadSavedTemplates().map(item => item.name));
    expect(names).toContain("Offline tab one");
    expect(names).toContain("Offline tab two");
    await page.reload();
    await page.waitForFunction(() => librarySync.ready && !librarySync.saving);
    expect(await page.evaluate(() => librarySync.pending.length)).toBe(0);
  } finally { await peer.close(); }
});

test("reset clears the shared library while keeping prior work in Recent", async ({ page }) => {
  const before = await page.evaluate(() => ui.sessionId);
  await page.locator("#openTemplatesHeaderButton").click();
  await page.locator("#templateNameInput").fill("Reset this setup");
  await page.locator("#saveTemplateButton").click();
  await expect(page.locator("#saveTemplateButton")).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.locator("#moreButton").click();
  await page.locator("#resetMenuButton").click();
  await page.locator("#confirmDialog").getByRole("button", { name: "Reset everything", exact: true }).click();
  await expect.poll(() => page.evaluate(() => ui.sessionId)).not.toBe(before);
  const library = await page.request.get("/api/library");
  expect((await library.json()).templates).toHaveLength(0);
  expect((await library.json()).palettes).toHaveLength(0);
  expect((await page.request.get("/api/sessions/" + before)).ok()).toBe(true);
  await page.locator('[data-view="layout"]').click();
  const footer = page.locator("#footerInput");
  await footer.uncheck();
  await footer.focus();
  await footer.press("Space");
  await expect(footer).toBeChecked();
  expect(await page.evaluate(() => documentState.layout.footer)).toBe(true);
});

test("Enter never creates rows, while final-cell Tab adds exactly one", async ({ page }) => {
  await page.locator("#addRowButton").click();
  const last = page.locator("#dataBody .cell-input").last();
  await last.fill("code");
  await last.press("Enter");
  await expect(page.locator("#dataBody tr")).toHaveCount(1);
  await last.press("Tab");
  await expect(page.locator("#dataBody tr")).toHaveCount(2);
  await expect(page.locator("#dataBody .cell-input").nth(4)).toBeFocused();
  await page.locator("#appendRowButton").click();
  await expect(page.locator("#dataBody tr")).toHaveCount(3);
});

test("the simplified header menu and sidebar do not have accidental letter shortcuts", async ({ page }) => {
  await expect(page.locator(".rail-nav kbd, .rail-nav .nav-icon")).toHaveCount(0);
  await expect(page.locator(".header-actions > #commandButton")).toHaveCount(0);
  await page.locator('[data-view="layout"]').click();
  await page.keyboard.press("n");
  await page.keyboard.press("i");
  await page.keyboard.press("d");
  expect(await page.evaluate(() => documentState.rows.length)).toBe(0);
  await expect(page.locator("#layoutView")).toHaveClass(/active/);
  await expect(page.locator("#importDialog")).not.toBeVisible();
  await page.locator("#moreButton").click();
  await expect(page.locator("#moreMenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#moreMenu")).not.toBeVisible();
  await page.locator("#moreButton").click();
  await page.locator("#commandButton").click();
  await expect(page.locator("#commandDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#commandDialog")).not.toBeVisible();
  await page.keyboard.press("Meta+k");
  await expect(page.locator("#commandDialog")).toBeVisible();
});

test("an unblurred cell is saved and resumes in a different browser context", async ({ page, browser }) => {
  await page.locator("#addRowButton").click();
  await page.locator('#dataBody input[data-column-id="name"]').fill("Edited without blur");
  await expect(page.locator("#saveStatus")).toHaveText("Saved");
  const other = await browser.newContext();
  try {
    const resumed = await other.newPage();
    await resumed.goto("/");
    await expect(resumed.locator('#dataBody input[data-column-id="name"]')).toHaveValue("Edited without blur");
    await expect(resumed.locator("#dataBody tr")).toHaveCount(1);
  } finally { await other.close(); }
});

test("Escape restores a cell and the restored value survives reload", async ({ page }) => {
  await page.locator("#addRowButton").click();
  const cell = page.locator('#dataBody input[data-column-id="name"]');
  await cell.fill("Original");
  await cell.press("Tab");
  await cell.fill("Discard this");
  await cell.press("Escape");
  await expect(cell).toHaveValue("Original");
  await expect(page.locator("#saveStatus")).toHaveText("Saved");
  await page.reload();
  await expect(cell).toHaveValue("Original");
});

test("field text selection is independent of drag handles and reorder works", async ({ page }) => {
  await page.locator('[data-view="columns"]').click();
  const name = page.locator('[data-column-id="name"] .column-label-input');
  await name.click({ clickCount: 3 });
  await name.press("Shift+ArrowLeft");
  await expect(page.locator(".column-row").first()).toHaveAttribute("data-column-id", "name");
  const from = await page.locator('[data-column-id="name"] .drag-handle').boundingBox();
  const to = await page.locator('.column-row[data-column-id="password"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 30, to.y + to.height - 10, { steps: 20 });
  await page.mouse.up();
  await expect(page.locator(".column-row").first()).toHaveAttribute("data-column-id", "username");
  await expect(page.locator(".column-row")).toHaveCount(4);
});

test("row actions stay usable in a narrow panel and dismiss with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.locator("#addRowButton").click();
  await page.locator("#dataBody .row-select").check();
  await page.locator("#rowActionsButton").click();
  await expect(page.locator("#selectedRowActions")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#selectedRowActions")).not.toBeVisible();
  const toolbar = await page.locator("#selectionToolbar").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(toolbar.scroll).toBeLessThanOrEqual(toolbar.width);
});

test("rule controls remain checkbox sized and editable", async ({ page }) => {
  await page.locator('[data-view="rules"]').click();
  await page.locator("#addRuleButton").click();
  const active = page.locator(".rule-enabled-input");
  await expect(active).toBeChecked();
  const size = await active.boundingBox();
  expect(size.width).toBeLessThanOrEqual(20);
  await active.uncheck();
  await expect(active).not.toBeChecked();
  await expect(page.locator(".rule-card")).toHaveClass(/disabled/);
});

test("rule controls fit when the preview leaves a narrow editor", async ({ page }) => {
  await page.setViewportSize({width: 1100, height: 850});
  await page.evaluate(() => setPreviewWidth(920));
  await page.locator('[data-view="rules"]').click();
  await page.locator("#addRuleButton").click();
  const overflowing = await page.locator(".rule-card").evaluate(card => {
    const bounds = card.getBoundingClientRect();
    return [...card.querySelectorAll("input,select,button,label")].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1);
    }).map(el => el.className);
  });
  expect(overflowing).toEqual([]);
  await page.screenshot({path: "test-results/rule-editor-narrow.png"});
});

test("renaming a rule then clicking Add condition acts on the first click", async ({ page }) => {
  await page.locator('[data-view="rules"]').click();
  await page.locator("#addRuleButton").click();
  await page.locator(".rule-name-input").fill("Rename without losing the next click");
  await expect(page.locator(".condition-delete")).toBeDisabled();
  await page.locator('[data-action="add-condition"]').click();
  await expect(page.locator(".condition-row")).toHaveCount(2);
  await expect(page.locator(".rule-name-input")).toHaveValue("Rename without losing the next click");
  await expect(page.locator(".condition-delete").first()).toBeEnabled();
});

test("live rule editing updates its match count, saves before blur, and preserves name and target", async ({ page }) => {
  await page.locator("#addRowButton").click();
  await page.locator('#dataBody input[data-column-id="name"]').fill("Person");
  await page.locator('[data-view="rules"]').click();
  await page.locator("#addRuleButton").click();
  await page.locator(".rule-target-input").selectOption("password");
  await page.locator(".condition-operator").selectOption("equals");
  await page.locator(".condition-value").fill("Person");
  await expect(page.locator(".rule-match-count")).toHaveText("1 matching");
  await expect(page.locator("#saveStatus")).toHaveText("Saved");
  await page.reload();
  await page.waitForFunction(() => ui.sessionReady);
  await expect(page.locator(".condition-value")).toHaveValue("Person");
  await page.locator(".rule-name-input").fill("My visibility rule");
  await page.locator(".rule-action-input").selectOption("show_field");
  await expect(page.locator(".rule-name-input")).toHaveValue("My visibility rule");
  await expect(page.locator(".rule-target-input")).toHaveValue("password");
});

test("field names save while typing and defaults can be edited without losing the next click", async ({ page }) => {
  await page.locator('[data-view="columns"]').click();
  const name = page.locator('.column-row[data-column-id="name"] .column-label-input');
  await name.fill("Full name");
  await expect(page.locator("#saveStatus")).toHaveText("Saved");
  await page.reload();
  await page.waitForFunction(() => ui.sessionReady);
  await expect(name).toHaveValue("Full name");
  await page.locator('.column-row[data-column-id="name"] .column-default-input').fill("New starter");
  await page.locator('.column-row[data-column-id="name"] [data-action="duplicate-column"]').click();
  await expect(page.locator(".column-row")).toHaveCount(5);
  await page.locator('[data-view="data"]').click();
  await page.locator("#addRowButton").click();
  await expect(page.locator('#dataBody input[data-column-id="name"]')).toHaveValue("New starter");
});

test("field actions use an Escape-dismissable menu and the settings sheet keeps pending edits", async ({ page }) => {
  await page.locator('[data-column-id="name"] .data-field-menu-trigger').click();
  await expect(page.locator("#dataFieldMenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#dataFieldMenu")).not.toBeVisible();
  await expect(page.locator('[data-column-id="name"] .data-field-menu-trigger')).toBeFocused();
  await page.locator('[data-column-id="name"] .data-field-menu-trigger').click();
  await page.locator("#dataFieldRenameInput").fill("Full name");
  await page.locator("#dataFieldOptionsButton").click();
  await expect(page.locator("#fieldSheetDialog")).toBeVisible();
  await expect(page.locator("#fieldSheetName")).toHaveValue("Full name");
  await page.locator("#fieldSheetDefault").fill("Default name");
  await page.locator("#fieldSheetDone").click();
  await page.locator("#addRowButton").click();
  await expect(page.locator('#dataBody input[data-column-id="name"]')).toHaveValue("Default name");
  await page.locator('[data-column-id="name"] .data-field-menu-trigger').click();
  await page.locator("#dataFieldRenameInput").fill("   ");
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-column-id="name"] .data-field-title')).toHaveText("Untitled field");
});

test("adding a row on the next page reveals it and resets selection", async ({ page }) => {
  await page.evaluate(() => {
    documentState.rows = Array.from({length: 25}, (_, index) => ({id: "test" + index, values: {name: "Row " + index}, hidden: false, overrides: {}}));
    ui.pageSize = 25;
    renderAll();
  });
  await page.locator("#dataBody .row-select").first().check();
  await page.locator("#appendRowButton").click();
  await expect(page.locator("#dataPageLabel")).toHaveText("Page 2 / 2");
  await expect(page.locator("#dataBody tr")).toHaveCount(1);
  await expect(page.locator("#selectionToolbar")).not.toBeVisible();
  await expect(page.locator("#dataBody .cell-input").first()).toBeFocused();
});

test("typing before session loading finishes is never overwritten", async ({ browser }) => {
  const context = await browser.newContext();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const page = await context.newPage();
    await page.route("**/api/sessions", async route => { await gate; await route.continue(); });
    await page.goto("/");
    await page.locator("#addRowButton").click();
    await page.locator('#dataBody input[data-column-id="name"]').fill("Started immediately");
    release();
    await page.waitForFunction(() => ui.sessionReady);
    await expect(page.locator("#saveStatus")).toHaveText("Saved");
    await expect(page.locator('#dataBody input[data-column-id="name"]')).toHaveValue("Started immediately");
    await page.reload();
    await page.waitForFunction(() => ui.sessionReady);
    await expect(page.locator('#dataBody input[data-column-id="name"]')).toHaveValue("Started immediately");
  } finally { release(); await context.close(); }
});

test("imports remember renamed and hidden fields and never infer a date type", async ({ page }) => {
  const file = {name: "test.csv", mimeType: "text/csv", buffer: Buffer.from("Candidate,Password,Start Date\nTest person,pw,2026-10-01\nHidden person,pw2,2026-10-02\n")};
  await page.locator("#dataImportButton").click();
  await page.locator("#workbookInput").setInputFiles(file);
  await expect(page.locator(".mapping-row")).toHaveCount(3);
  await expect(page.locator("#importMode")).toHaveValue("replace");
  await expect(page.locator("#importColumnMode")).toHaveValue("replace");
  await expect(page.locator(".mapping-include:checked")).toHaveCount(0);
  await page.locator("#includeAllColumnsButton").click();
  await page.locator('.mapping-row[data-source-header="Candidate"] .mapping-new-name').fill("Name to print");
  await page.locator('.mapping-row[data-source-header="Start Date"] .mapping-visibility').selectOption("never");
  await page.locator("#importHiddenRowNumbers").fill("3");
  await page.locator("#confirmImportButton").click();
  await page.locator("#confirmActionButton").click();
  await expect(page.locator("#importDialog")).not.toBeVisible();
  await expect(page.locator("#dataBody tr")).toHaveCount(1);
  expect(await page.evaluate(() => documentState.columns.find(field => field.sourceNames.includes("Start Date")).type)).toBe("text");
  await page.locator("#dataImportButton").click();
  await page.locator("#workbookInput").setInputFiles(file);
  await expect(page.locator(".mapping-include:checked")).toHaveCount(3);
  await expect(page.locator('.mapping-row[data-source-header="Candidate"] .mapping-new-name')).toHaveValue("Name to print");
  await expect(page.locator('.mapping-row[data-source-header="Start Date"] .mapping-visibility')).toHaveValue("never");
});

test("an in-flight sync response never overwrites a newly edited cell", async ({ page }) => {
  await page.locator("#addRowButton").click();
  await page.locator('#dataBody input[data-column-id="name"]').fill("Original");
  await page.locator("#rowSearch").focus();
  await expect(page.locator("#saveStatus")).toHaveText("Saved");
  const remote = await page.evaluate(() => {
    const workspace = currentSessionWorkspace();
    workspace.document.rows[0].values.name = "Other tab";
    return {id: ui.sessionId, revision: ui.sessionRevision + 1, workspace};
  });
  let release, intercepted;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { intercepted = resolve; });
  await page.route(`**/api/sessions/${remote.id}`, async route => {
    intercepted();
    await gate;
    await route.fulfill({json: remote});
  });
  await page.evaluate(() => { window.pendingTestPoll = pollCurrentSession(); });
  await started;
  await page.locator('#dataBody input[data-column-id="name"]').fill("My new edit");
  release();
  await page.evaluate(() => window.pendingTestPoll);
  await expect(page.locator('#dataBody input[data-column-id="name"]')).toHaveValue("My new edit");
});

test("data and PDF preview scroll, selection scopes the live PDF, and zoom works", async ({ page }) => {
  await page.evaluate(() => {
    documentState.rows = Array.from({length: 50}, (_, index) => ({id: "test" + index, values: {name: "Row " + index}, hidden: false, overrides: {}}));
    renderAll();
  });
  await expect(page.locator('.pdf-preview-page[data-rendered="true"] canvas').first()).toBeVisible();
  await page.locator("#tableShell").evaluate(el => { el.scrollTop = 300; });
  expect(await page.locator("#tableShell").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.locator("#pdfPreviewPages").evaluate(el => { el.scrollTop = 300; });
  expect(await page.locator("#pdfPreviewPages").evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.locator("#dataBody .row-select").first().check();
  await expect(page.locator("#previewStats")).toContainText("1 printable");
  await expect(page.locator(".pdf-preview-page")).toHaveCount(1);
  await page.locator("#zoomInButton").click();
  await expect(page.locator("#zoomLabel")).toHaveText("135%");
  await expect(page.locator('.pdf-preview-page[data-rendered="true"] canvas')).toBeVisible();
  await page.locator("#rowSearch").fill("Row 1");
  await expect(page.locator("#selectionToolbar")).not.toBeVisible();
  await expect(page.locator("#exportPdfButton")).toHaveAttribute("title", "Export 50 printable slips");
  await page.screenshot({path: "test-results/data-editor.png"});
});
