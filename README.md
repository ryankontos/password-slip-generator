# password-slip-generator

A small local utility for turning Excel rows into precisely aligned A4 password slips. Import a workbook, edit the copied rows, choose fields and rules, tune the design with a live preview, then export or open the PDF. The source workbook is never changed.

On macOS, open `run_password_slips.command`. On Windows, open `run_password_slips.bat`. The first launch creates a local Python environment and installs `openpyxl` and `reportlab`; later launches open the saved workspace directly in your browser.

The app runs only on your computer. Its editable workspace is stored in `settings/web_workspace.json`, while temporary previews stay in `tmp/`. Python 3.9 or newer is required.

Slip fields are independent of Excel. Edit `default_column_names`, `password_column_names`, and `truncate_column_names` in `settings/settings.json` to define the initial fields; capitals and repeated spaces do not matter. Every import shows a remembered mapping from Excel columns to those fields before rows are copied. Fill rules can then populate another field for all rows or for rows matching a value.

Created by Ryan Kontos, 2026. Licensed under the permissive [0BSD licence](LICENSE).
