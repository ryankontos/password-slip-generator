# More reliable editing

- Simplified the header: Recent, Templates, and Export remain visible, while Commands and secondary actions are in More. Removed decorative sidebar glyphs, shortcut badges, duplicate menu entries, and single-letter action shortcuts.
- Cell values autosave while typing, without waiting for focus to leave the field. Escape restores the value from the start of the edit, and each editing session remains one undo step.
- Enter navigates existing rows without adding a row. Tab from the last cell still adds one new row, opens its page, and focuses its first field.
- Row, field, and rule dragging now uses SortableJS with dedicated handles. Reordering a filtered or paginated list preserves undisplayed item positions.
- Selected-row actions are grouped in an Escape-dismissable menu; export stays in the header and the selection bar wraps in narrower panels.
- Rule checkboxes retain their proper size, and Invert result has a clearer label.
- Canceling a reused delete/reset confirmation no longer risks repeating a previous approval.
- Duplicate final autosaves no longer create false recovered sessions.
- Fresh browsers resume the latest session instead of creating an empty one. New sessions and saves made within the same second are ordered correctly.
- Edits made while session loading or tab synchronization is in progress are preserved.
- Added editor unit tests and isolated browser regression tests for editing, keyboard navigation, autosave, selection, and reordering.
