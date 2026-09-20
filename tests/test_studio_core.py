from __future__ import annotations

import io
from pathlib import Path
import sys
import unittest

from openpyxl import Workbook


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from studio_core import _display_value, _value_align, included_rows, parse_workbook, pdf_layout, render_pdf, visible_columns  # noqa: E402


def sample_state() -> dict:
    return {
        "name": "Test slips",
        "columns": [
            {"id": "name", "label": "Name", "visibility": "always", "style": "strong", "width": 1},
            {"id": "code", "label": "Code", "visibility": "nonempty", "style": "mono", "width": 1},
        ],
        "rows": [
            {"id": "one", "values": {"name": "Ava", "code": "A-123"}, "overrides": {}, "disabled": False},
            {"id": "two", "values": {"name": "Noah", "code": ""}, "overrides": {}, "disabled": False},
            {"id": "three", "values": {"name": "Hidden", "code": "X"}, "overrides": {}, "disabled": True},
        ],
        "rules": [],
        "layout": {"mode": "horizontal", "paper": "a4", "orientation": "portrait", "slipHeight": 36},
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

    def test_nonempty_visibility_requires_an_alphanumeric_character(self) -> None:
        state = sample_state()
        state["rows"][1]["values"]["code"] = " - / _ "
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name"])
        state["rows"][1]["values"]["code"] = " - É - "
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name", "code"])

    def test_layout_cannot_override_only_with_a_value(self) -> None:
        state = sample_state()
        state["layout"]["showBlankFields"] = True
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][1])], ["name"])

    def test_global_column_order_is_used_for_every_slip(self) -> None:
        state = sample_state()
        state["rows"][0]["layoutOverride"] = {"columnOrder": ["code", "name"]}
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][0])], ["name", "code"])

    def test_only_explicitly_hidden_rows_are_excluded(self) -> None:
        state = sample_state()
        state["rows"][1]["hidden"] = True
        self.assertEqual([row["id"] for row in included_rows(state)], ["one"])

    def test_hide_slip_rule_can_match_empty_or_exact_values(self) -> None:
        state = sample_state()
        state["rows"][2]["disabled"] = False
        state["rules"] = [{
            "enabled": True,
            "action": "hide_slip",
            "match": "any",
            "conditions": [
                {"field": "code", "operator": "empty", "value": ""},
                {"field": "name", "operator": "equals", "value": "Hidden"},
            ],
        }]
        self.assertEqual([row["id"] for row in included_rows(state)], ["one"])

    def test_hide_field_wins_when_show_and_hide_rules_both_match(self) -> None:
        state = sample_state()
        condition = [{"field": "name", "operator": "equals", "value": "Ava"}]
        state["rules"] = [
            {"enabled": True, "action": "hide_field", "target": "code", "conditions": condition},
            {"enabled": True, "action": "show_field", "target": "code", "conditions": condition},
        ]
        self.assertEqual([column["id"] for column in visible_columns(state, state["rows"][0])], ["name"])


class PdfTests(unittest.TestCase):
    def test_both_layout_modes_produce_a_pdf(self) -> None:
        for mode in ("horizontal", "stacked"):
            with self.subTest(mode=mode):
                state = sample_state()
                state["layout"]["mode"] = mode
                pdf = render_pdf(state)
                self.assertTrue(pdf.startswith(b"%PDF"))
                self.assertGreater(len(pdf), 1_000)

    def test_colour_font_and_spacing_controls_produce_a_pdf(self) -> None:
        state = sample_state()
        state["layout"].update({
            "mode": "stacked",
            "accent": "#a64032",
            "valueAlign": "right",
            "labelWidth": 42,
            "padding": 3.5,
            "paperColor": "#fffdf5",
            "borderColor": "#7c8799",
            "font": "Times-Roman",
            "labelFont": "Courier",
            "labelCase": "title",
            "fieldLines": False,
        })
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_column_alignment_can_override_sheet_alignment(self) -> None:
        state = sample_state()
        state["layout"]["valueAlign"] = "left"
        state["columns"][0]["valueAlign"] = "right"
        layout = pdf_layout(state)
        self.assertEqual(_value_align(state["columns"][0], layout), "right")
        self.assertEqual(_value_align(state["columns"][1], layout), "left")

    def test_unknown_legacy_mode_falls_back_to_horizontal(self) -> None:
        state = sample_state()
        state["layout"]["mode"] = "grid"
        self.assertEqual(pdf_layout(state).mode, "horizontal")
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))

    def test_large_projects_render_multiple_pages(self) -> None:
        state = sample_state()
        state["rows"] = [
            {"id": f"row-{index}", "values": {"name": f"Person {index}", "code": f"CODE-{index}"}, "overrides": {}}
            for index in range(14)
        ]
        state["layout"].update({"slipHeight": 70})
        pdf = render_pdf(state)
        self.assertGreaterEqual(pdf.count(b"/Type /Page"), 2)

    def test_stacked_layout_handles_many_columns(self) -> None:
        state = sample_state()
        state["columns"] = [
            {"id": f"field_{index}", "label": f"Field {index}", "visibility": "always", "style": "standard", "width": 1}
            for index in range(12)
        ]
        state["rows"] = [{
            "id": "many",
            "values": {column["id"]: f"Value {index}" for index, column in enumerate(state["columns"])},
            "overrides": {},
        }]
        state["layout"].update({"mode": "stacked", "stackedColumns": 2, "slipHeight": 72})
        self.assertEqual(pdf_layout(state).stacked_columns, 2)
        self.assertTrue(render_pdf(state).startswith(b"%PDF"))


if __name__ == "__main__":
    unittest.main()
