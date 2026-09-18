# Password Slip Studio

Password Slip Studio is a local browser workspace for building, editing, and printing password slips. Data and projects stay on the computer running the app.

## Start

On macOS, double-click `run_password_slip_studio.command` (the existing `run_password_slips.command` now opens the same studio). The first run creates `.venv` and installs the workbook/PDF dependencies.

From a terminal:

```bash
python3 start_password_slip_studio.py
```

The studio opens at `http://127.0.0.1:8768`. Use `--no-open` to start it without opening a browser.

## Studio workflow

- Define, rename, type (text, password, number, date/time, or URL), format, resize, transform values (as entered, case changes, or mask-last-four), align each value independently or inherit the sheet alignment, mark as required or unique, duplicate, delete, and drag-reorder columns. Required blanks, duplicate values, and invalid number/date/URL entries are flagged in the data grid.
- Add and drag-reorder rows, edit cells inline, duplicate selections, export selected rows, sort/filter the working view, and keep rows excluded without deleting them. Required fields are highlighted when a row is incomplete.
- Browse large sheets through paginated data-grid views with adjustable page sizes while selection, filtering, sorting, and export continue to work across the full result set.
- Bulk-edit selected rows in one previewed action: set, clear, find/replace, add prefixes or suffixes, change case, or trim whitespace.
- Paste tab/newline blocks directly from Excel or Sheets into any focused grid cell; additional rows are created automatically when needed.
- Save named data views for repeatable filter and sort combinations; switch between saved views without changing the underlying rows.
- Export the currently filtered included rows as a PDF in the same order as the active data view, while keeping the full-project export available.
- Export the full data table to CSV or copy the currently filtered view as tab-separated text from the data tools or command palette.
- Import `.xlsx`, `.xlsm`, and `.csv` files. Choose a worksheet and map each source column to an existing field, a new field, or skip it. Mapping suggests exact and common credential-field matches, infers sensible types for newly created fields, shows a review summary, and blocks accidental duplicate mappings. Imports default to replacing every current row, can append instead, and can rename the project during import.
- Create per-row rules with all/any condition groups and an optional “Not” inversion. Rules can show or hide fields, include rows, or exclude rows. Operators cover blank values, exact/partial text, numeric comparison, and regular expressions. Rules can be named, reordered, duplicated, disabled, and show a live matching-row count while editing.
- Test the rule stack against any imported or manually entered row; each rule reports whether it matches that test row while you edit conditions.
- Set field defaults such as **Only with a value**, then override visibility for an individual row when needed.
- Open Row options to customize an individual slip without changing the sheet: choose its layout mode, field columns, field order, label position, alignment, typography, spacing, text/rule colours, accent, paper colour, row-specific logo, border, dividers, alternating fields, header treatment, header/subheading, or footer note.
- Apply any saved layout preset as a per-row starting point, then refine that slip independently.
- Select multiple rows and use **Customize slips** to open one row’s options, then copy its complete layout and field-visibility overrides to the selection; customized rows are marked in the grid.
- Reset selected slip customizations in one confirmed action to return those rows to the sheet layout and automatic field visibility.
- Choose horizontal, stacked, grid, compact, dense, cards, ledger, hero, or grouped sections layouts. Assign optional field groups so large slips can be organised into named panels. Configure fields per row, label position and case, value alignment, typeface, label width, padding, corner radius, paper and rule colours, alternating cells, dividers, paper, orientation, fill order, slips across, height, spacing, borders, cut marks, and footer.
- Save named layout presets inside a studio file and reapply or remove them as the layout evolves.
- Add optional neutral header text, subheading, footer note, logo, and line/band/outlined header treatments at sheet level; these are blank by default and can be overridden per slip.
- Save/open portable `.password-slips.json` studio files. A working copy is also saved automatically in the browser.
- Export the current included rows as a real PDF with the same rules and layout used by the preview.
- PDF export performs a preflight for missing required values and duplicate unique values, with an explicit option to continue when those warnings are intentional.
- Page through the sheet preview before export; page navigation follows the selected paper, slip size, spacing, and slips-across settings.
- Drag the divider beside the sheet preview to give the preview more or less room; the panel width is remembered locally and can also be adjusted with the keyboard when focused.

Press `⌘K` / `Ctrl+K` for the command palette. Other shortcuts are shown in the interface.

New studios start with the editable column schema and no sample rows or example credentials; the repository ships without a demo workbook.

## Development

```bash
python3 -m pip install -r requirements.txt
python3 -m unittest discover -s tests
PYTHONPATH=src python3 src/studio_server.py --verbose
```

The original terminal generator remains in `src/password_slips.py` for compatibility and as a reference implementation.

Created by Ryan Kontos, 2026. Licensed under the [0BSD licence](LICENSE).
