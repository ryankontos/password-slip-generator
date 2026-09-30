const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => ui.sessionReady);
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
