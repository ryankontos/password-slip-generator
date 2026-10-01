# Password Slip Studio

Password Slip Studio is a local browser tool for turning spreadsheet rows into printable password slips. It autosaves revisioned sessions to the local Studio service so work can be resumed from another tab or browser, while retaining a browser copy as an offline fallback. Portable workspace and template files are also supported.

## Start

On macOS, double-click `run_password_slip_studio.command` to launch the browser studio, or `run_password_slips.command` to use the original terminal generator. Both launchers use the repository's `.venv` and install workbook/PDF dependencies on first run.

From a terminal:

```bash
python3 start_password_slip_studio.py
```

The studio opens at `http://127.0.0.1:8768` and keeps running in the background after the launcher closes. Pass `--no-open` to start it without opening a browser, `--foreground` to keep it attached to the terminal, or `--port 8878` to use another local port. Use App settings (⚙) to quit Studio. Autosaved sessions are stored atomically with a backup in the ignored `runtime/` directory.

App settings also lets you start Studio at macOS login and check for updates. The update monitor checks the selected update channel every minute. Stable releases track `master`; Development builds track `development` when that branch is published. Available updates show their release notes before installing; an update only switches or fast-forwards a clean checkout, then restarts the background service. It never overwrites local edits. The local service log and settings are in the ignored `runtime/` directory. Browser workspace data remains in the browser.

To run the original command-line generator directly:

```bash
python3 src/password_slips.py
```

## Studio workflow

- Start with an empty data set. Define fields, add rows manually, or import a workbook.
- Edit rows inline, paste tab-separated blocks from Excel or Sheets, duplicate rows, reorder rows, hide slips, bulk edit selected rows, and export CSV.
- Resize Data-grid field widths by dragging a header divider or using its arrow keys. Widths are saved with the workspace/template. Click a field heading for its settings sheet, or use its menu to rename, reorder, duplicate, or delete without leaving Data. In Fields, only the handle starts a reorder drag, so field names remain selectable.
- Use the `New row` button at the bottom of the data table or `⌘↵`. A field can provide a default value for every manually added row. In the grid, `Enter`/`⇧Enter` moves down/up through existing rows and never adds rows. `Tab`/`⇧Tab` moves across fields; reaching the end with `Tab` adds one row when no filter is active, reveals its page, and focuses its first field.
- Cell edits autosave as you type. `Escape` cancels the current cell edit; undo treats each cell editing session as one change.
- Field names, defaults, rule names, condition values, and rule text also save while typing. Rules read If … Then …, preserve custom names when changing actions, and adapt to a narrow editor beside a larger preview.
- Filter rows to work quickly. Filtering clears the selection; Shift-click row checkboxes to select a visible range. With no rows selected, PDF preview and export use every printable row.
- Import `.xlsx`, `.xlsm`, and `.csv` files. The default is to replace existing rows. Select a worksheet, choose all or specific spreadsheet row numbers, mark imported rows hidden, and opt in to fields one at a time.
- Replace the current field set or keep it and map spreadsheet fields into existing fields. New fields can have their own display names. Field mappings are remembered by sheet name and headers, not by the workbook file.
- Fields default to text. Password-like headers are inferred as password fields; all other imported fields remain text unless changed manually.
- Set field visibility to Always, Only with a value (an alphanumeric character is required), or Hidden by default. Rules can show/hide fields or hide an entire slip using all/any conditions and Invert result. Hide wins when show and hide rules conflict.
- Select rows to customize field visibility together, apply one selected row's visibility to the selection, or reset selected rows to automatic visibility.
- Hidden imported rows remain available in the rule tester and data model but are not shown in the data list or printed.
- Use Manage hidden below the data table to selectively make hidden rows printable again without putting them back into the main list.
- Choose one of two layouts: Horizontal (the compact label band format) or Stacked (better for many fields, with an optional two-column arrangement). Configure paper, orientation, margin, gap, slip height, colours, font families, label/value sizes, label case, borders, field dividers, cut marks, and footer.
- Stacked slips can set the label-column width and, in two-column mode, the first column's share of the slip. Optional small text below slips has its own typeface and size; the last matching note rule can replace or clear it per slip. PDF pages reserve the height of the longest note beneath every slip. Export filenames can append the date or a local date-and-time stamp (`YYYY-MM-DD_HH-mm`).
- The preview is generated from the same server-rendered PDF used for export. It updates while editing and after selection changes, renders large documents page-by-page as you scroll, can be zoomed from 50% to 600%, and the divider beside it can be dragged or adjusted with the keyboard.
- Name the document in the header; the title becomes the PDF filename. Save named colour palettes, workspaces, and templates. Templates and palettes are shared across browsers on this Mac; older browser saves migrate automatically. Workspace/template files include document settings, palettes, preferences, and reusable import mappings. Opening an older session does not replace the shared library.
- Template and palette changes use a durable browser outbox during service outages and sync after reconnecting, even after a reload. Replacing a named save requires confirmation; conflicting changes from another browser keep both versions. Saved templates, palettes, and Recent sessions are not silently removed to enforce a fixed list size.
- Changes autosave to a shared Recent session. Use Recent in the header to resume work from any browser on this Mac or start a blank session without losing the previous one. Open tabs detect newer revisions automatically; simultaneous edits are preserved as a separate recovered session instead of silently overwriting either copy.
- The header keeps Recent, Templates, and Export directly accessible. Commands and secondary actions are in the More menu. The sidebar contains plain section names without shortcut badges; unmodified letter keys do not navigate or create rows.
- Use `⌘K` for commands. Other shortcuts are listed in the Keyboard shortcuts dialog. `⌘Z` and `⇧⌘Z` keep native text-field undo available while editing.

## Development

```bash
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests
PYTHONPATH=src python3 src/studio_server.py --verbose
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

Row, field, and rule reordering uses pinned SortableJS rather than separate hand-written drag implementations. Its browser bundle and licence are committed in `web/vendor/`, so launchers do not need Node or a CDN. Run `npm run vendor` after changing the dependency. Browser regression tests run against an isolated temporary session store and never touch real saved sessions.

The original terminal generator remains in `src/password_slips.py` and is available through `run_password_slips.command` as a separate workflow from the studio.

Created by Ryan Kontos, 2026. Licensed under the [0BSD licence](LICENSE).
