# Visualization Output Skill

When analysis context is present and a visual aid will help, append a single `viz` JSON block at the end of the response.

Allowed `type` values:
- `unified_analysis`
- `subgroup_breakdown`
- `grade_comparison`
- `flag_overlap`
- `text_insight`
- `student_table`

Rules:
- Use only values from CURRENT ANALYSIS DATA.
- Do not use risk-tier labels in visualization JSON.
- Round percentages to 1 decimal place.
- Include `next_actions` (2-3 items).
- Include `insights` entries with levels (`red`, `amber`, `teal`) when applicable.
- Do not mention the JSON block in prose.
- If the user is conversational and no data context is available, skip viz output.
