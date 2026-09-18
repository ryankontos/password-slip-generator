from __future__ import annotations

import io
from pathlib import Path
import sys
import unittest

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from studio_core import _display_value, _value_align, included_rows, parse_workbook, pdf_layout, render_pdf, row_pdf_layout, visible_columns  # noqa: E402


def sample_state() -> dict:
    return {
        "name": "Test slips",
        "columns": [
            {"id": "name", "label": "Name", "group": "Identity", "visibility": "always", "style": "strong", "width": 1},
            {"id": "code", "label": "Code", "group": "Access", "visibility": "nonempty", "style": "mono", "width": 1},
        ],
        "rows": [
            {"id": "one", "values": {"name": "Ava", "code": "A-123"}, "overrides": {}, "disabled": False},
            {"id": "two", "values": {"name": "Noah", "code": ""}, "overrides": {}, "disabled": False},
            {"id": "three", "values": {"name": "Hidden", "code": "X"}, "overrides": {}, "disabled": True},
        ],
        "rules": [],
        "layout": {"mode": "grid", "paper": "a4", "orientation": "portrait", "across": 1, "slipHeight": 42},
    }


class WorkbookImportTests(unittest.TestCase):
    def test_csv_import_makes_headers_unique(self) -> None:
        result = parse_workbook("people.csv", b"Name,Name,Password\nAva,Chen,Maple!482\n\nNoah,West,River!193\n")
        self.assertEqual(result["sheets"][0]["headers"], ["Name", "Name (2)", "Password"])
        self.assertEqual(result["sheets"][0]["rows"][0][2], "Maple!482")
        self.assertEqual(result["sheets"][0]["rowNumbers"], [2, 4])

    def test_excel_import_ignores_hidden_rows_and_sheets(self) -> None:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "People"
        sheet.append(["Name", "Password"])
        sheet.append(["Ava", "one"])
        sheet.append(["Noah", "two"])
        sheet.row_dimensions[3].hidden = True
        hidden = workbook.create_sheet("Hidden")
        hidden.sheet_state = "hidden"
        stream = io.BytesIO()
        workbook.save(stream)
        result = parse_workbook("people.xlsx", stream.getvalue())
        self.assertEqual([item["name"] for item in result["sheets"]], ["People"])
        self.assertEqual(result["sheets"][0]["rows"], [["Ava", "one"]])
        self.assertEqual(result["sheets"][0]["rowNumbers"], [2])


class RuleTests(unittest.TestCase):
    def test_column_value_transforms_are_display_only(self) -> None:
        self.assertEqual(_display_value({"valueTransform": "upper"}, "Taylor"), "TAYLOR")
        self.assertEqual(_display_value({"valueTransform": "title"}, "service desk"), "Service Desk")
        self.assertEqual(_display_value({"valueTransform": "mask_last4"}, "abcdef1234"), "••••••1234")

    def test_nonempty_visibility_and_override(self) -> None:
        state = sample_state()
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name"])
        state["rows"][1]["overrides"]["code"] = True
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name", "code"])

    def test_individual_slip_can_reorder_visible_fields(self) -> None:
        state = sample_state()
        state["rows"][0]["layoutOverride"] = {"columnOrder": ["code", "name"]}
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][0])], ["code", "name"])
        state["rows"][1]["layoutOverride"] = None
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name"])

    def test_layout_can_reserve_empty_conditional_fields(self) -> None:
        state = sample_state()
        state["layout"]["showBlankFields"] = True
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name", "code"])

    def test_include_and_exclude_rules_are_evaluated_per_row(self) -> None:
        state = sample_state()
        state["rules"] = [
            {"enabled": True, "action": "include_row", "match": "all", "conditions": [{"field": "name", "operator": "contains", "value": "a"}]},
            {"enabled": True, "action": "exclude_row", "match": "all", "conditions": [{"field": "code", "operator": "empty", "value": ""}]},
        ]
        self.assertEqual([row["id"] for row in included_rows(state)], ["one"])

    def test_negated_rule_condition_group(self) -> None:
        state = sample_state()
        state["rules"] = [{
            "enabled": True,
            "action": "include_row",
            "match": "all",
            "negate": True,
            "conditions": [{"field": "name", "operator": "contains", "value": "ava"}],
        }]
        self.assertEqual([row["id"] for row in included_rows(state)], ["two"])


class PdfTests(unittest.TestCase):
    def test_every_layout_mode_produces_a_pdf(self) -> None:
        for mode in ("horizontal", "stacked", "grid", "compact", "dense", "cards", "ledger", "hero", "sections"):
            with self.subTest(mode=mode):
                state = sample_state()
                state["layout"]["mode"] = mode
                pdf = render_pdf(state)
                self.assertTrue(pdf.startswith(b"%PDF"))
                self.assertGreater(len(pdf), 1_000)

    def test_sections_layout_handles_named_field_groups(self) -> None:
        state = sample_state()
        state["layout"].update({"mode": "sections", "fieldColumns": 2, "labelPosition": "top"})
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_custom_layout_controls_produce_a_pdf(self) -> None:
        state = sample_state()
        state["rows"][0]["layoutOverride"] = {
            "mode": "hero",
            "accent": "#a64032",
            "fieldColumns": 1,
            "labelPosition": "left",
            "valueAlign": "right",
            "showBorder": False,
        }
        state["layout"].update({
            "mode": "cards",
            "fieldColumns": 4,
            "labelPosition": "left",
            "valueAlign": "right",
            "labelWidth": 42,
            "padding": 3.5,
            "radius": 2,
            "paperColor": "#fffdf5",
            "borderColor": "#7c8799",
            "font": "Times-Roman",
            "labelCase": "title",
            "fieldLines": False,
            "zebra": True,
        })
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_row_chrome_overrides_sheet_chrome(self) -> None:
        state = sample_state()
        state["layout"].update({"headerText": "Sheet title", "headerStyle": "line"})
        state["rows"][0]["layoutOverride"] = {"headerText": "Row title", "headerStyle": "band", "footerText": "Keep secure"}
        layout = row_pdf_layout(state, state["rows"][0], pdf_layout(state))
        self.assertEqual(layout.header_text, "Row title")
        self.assertEqual(layout.header_style, "band")
        self.assertEqual(layout.footer_text, "Keep secure")
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_row_typography_and_marks_overrides_are_safe(self) -> None:
        state = sample_state()
        state["rows"][0]["layoutOverride"] = {
            "font": "Times-Roman",
            "labelCase": "title",
            "labelSize": 11,
            "valueSize": 16,
            "labelWidth": 48,
            "padding": 4,
            "radius": 3,
            "ink": "#20252b",
            "borderColor": "#6a7280",
            "fieldLines": False,
            "zebra": True,
        }
        layout = row_pdf_layout(state, state["rows"][0], pdf_layout(state))
        self.assertEqual(layout.font, "Times-Roman")
        self.assertEqual(layout.label_case, "title")
        self.assertEqual(layout.label_size, 11)
        self.assertEqual(layout.value_size, 16)
        self.assertFalse(layout.field_lines)
        self.assertTrue(layout.zebra)
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_column_alignment_can_override_sheet_alignment(self) -> None:
        state = sample_state()
        state["layout"]["valueAlign"] = "left"
        state["columns"][0]["valueAlign"] = "right"
        layout = pdf_layout(state)
        self.assertEqual(_value_align(state["columns"][0], layout), "right")
        self.assertEqual(_value_align(state["columns"][1], layout), "left")
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_optional_logo_is_embedded_without_becoming_required(self) -> None:
        state = sample_state()
        state["layout"].update({
            "logoData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "headerText": "Access details",
        })
        layout = pdf_layout(state)
        self.assertTrue(layout.logo_data.startswith("data:image/png;base64,"))
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_row_logo_override_is_rendered_without_changing_sheet_logo(self) -> None:
        state = sample_state()
        state["layout"]["logoData"] = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        state["rows"][0]["layoutOverride"] = {
            "logoData": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        }
        layout = row_pdf_layout(state, state["rows"][0], pdf_layout(state))
        self.assertTrue(layout.logo_data.startswith("data:image/png;base64,"))
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_large_projects_render_multiple_pages(self) -> None:
        state = sample_state()
        state["rows"] = [
            {"id": f"row-{index}", "values": {"name": f"Person {index}", "code": f"CODE-{index}"}, "overrides": {}, "disabled": False}
            for index in range(14)
        ]
        state["layout"].update({"across": 2, "slipHeight": 70, "flow": "columns"})
        pdf = render_pdf(state)
        self.assertGreaterEqual(pdf.count(b"/Type /Page"), 2)


if __name__ == "__main__":
    unittest.main()
