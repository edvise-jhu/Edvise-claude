import pandas as pd
import numpy as np
import anthropic
import json
import os
import re
from typing import Optional

DEFAULTS = {
    "chronic_absence_threshold": 0.10,   # 10% days missed
    "severe_absence_threshold": 0.20,    # 20% days missed
    "total_school_days": 180,
    "suspension_min": 1,
    "academic_min_courses": 1,
    "absence_basis": "rate",  # "rate" | "days"
    "course_rules": None,
}

# Mapping roles shown on student rosters / usable in intent demographic_* filters.
ROSTER_DEMOGRAPHIC_ROLES = ("ell", "lep", "low_ses", "special_ed")

_claude = anthropic.Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_student_id_display(raw_id) -> str:
    """Format student IDs; fix float artifacts (e.g. 44.99999999999999 → 45)."""
    if raw_id is None:
        return ""
    try:
        if pd.isna(raw_id):
            return ""
    except (TypeError, ValueError):
        pass
    try:
        float_val = float(str(raw_id))
        if pd.isna(float_val):
            return ""
        rounded = round(float_val)
        if abs(float_val - rounded) < 0.01:
            return str(rounded)
        return str(raw_id)
    except (ValueError, TypeError, OverflowError):
        return str(raw_id)


def _json_safe_value(value):
    """Convert pandas/numpy NaN/Inf to JSON-safe None; keep normal scalars unchanged."""
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, (np.floating, float)):
        if np.isnan(value) or np.isinf(value):
            return None
        return float(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    return value


def _json_safe_records(records: list[dict]) -> list[dict]:
    out = []
    for row in records:
        safe_row = {k: _json_safe_value(v) for k, v in row.items()}
        out.append(safe_row)
    return out


# ---------------------------------------------------------------------------
# Variable mapping — Claude-powered with per-column metadata
# ---------------------------------------------------------------------------

def _build_mapping_from_metadata(metadata: dict) -> dict:
    """
    Convert per-column Claude metadata into the role-keyed mapping dict
    that all analysis functions expect.

    metadata shape:
      {
        "col_name": {
          "role": "attendance" | "sel_factor" | "race_indicator" | ...,
          "label": "Human-readable label",
          "description": "One-sentence description",
          "confidence": "high" | "medium" | "low"
        },
        ...
      }
    """
    mapping = {}
    race_indicators = []
    sel_factors = []
    text_cols = []

    # Roles that map one column -> one role key (first match wins)
    SINGULAR_ROLES = {
        'student_id', 'attendance', 'days_absent', 'behavior', 'math', 'english',
        'failtot', 'grade', 'gender', 'low_ses', 'special_ed',
        'lep', 'ell', 'parent_education', 'overage', 'race', 'ethnicity',
    }

    for col, info in metadata.items():
        role = info.get('role', 'ignore')

        if role == 'race_indicator':
            race_indicators.append(col)
        elif role == 'sel_factor':
            sel_factors.append(col)
        elif role == 'text_response':
            text_cols.append(col)
        elif role in SINGULAR_ROLES:
            if role not in mapping:   # first match wins
                mapping[role] = col
        # 'ignore' and 'other_demographic' are silently skipped

    if race_indicators:
        mapping['race_indicators'] = race_indicators
    if sel_factors:
        mapping['sel_factors'] = sel_factors
    if text_cols:
        mapping['text_columns'] = text_cols

    return mapping


def _generate_fallback_metadata(df: pd.DataFrame, mapping: dict) -> dict:
    """Generate basic column metadata from keyword mapping for the frontend."""
    ROLE_LABELS = {
        'student_id':       'Student ID',
        'attendance':       'Attendance Rate',
        'behavior':         'Suspensions / Behavior',
        'math':             'Math Failure Flag',
        'english':          'English / ELA Failure Flag',
        'failtot':          'Total Courses Failed',
        'grade':            'Grade Level',
        'gender':           'Gender / Sex',
        'low_ses':          'Socioeconomic Status',
        'special_ed':       'Special Education (IEP)',
        'lep':              'Limited English Proficiency',
        'ell':              'English Language Learner',
        'parent_education': 'Parent Education Level',
        'overage':          'Overage for Grade',
        'race':             'Race / Ethnicity',
        'ethnicity':        'Ethnicity',
        'race_indicator':   'Race / Ethnicity',
        'sel_factor':       'SEL Survey Score (1-5)',
        'text_response':    'Open-ended Text Response',
    }

    # Build reverse lookup: col -> role
    reverse: dict = {}
    for role, col in mapping.items():
        if role == 'race_indicators' and isinstance(col, list):
            for c in col:
                reverse[c] = 'race_indicator'
        elif role == 'sel_factors' and isinstance(col, list):
            for c in col:
                reverse[c] = 'sel_factor'
        elif role == 'text_columns' and isinstance(col, list):
            for c in col:
                reverse[c] = 'text_response'
        elif isinstance(col, str):
            reverse[col] = role

    metadata = {}
    for col in df.columns:
        role = reverse.get(col, 'ignore')
        if role == 'race_indicator':
            label = col.replace('_', ' ').title()
        else:
            label = ROLE_LABELS.get(role, col)
        metadata[col] = {
            'role':        role,
            'label':       label,
            'description': '',
            'confidence':  'high' if role != 'ignore' else 'low',
        }
    return metadata


def _validate_mapping(mapping: dict, df: pd.DataFrame) -> dict:
    """Remove any mapped column names that don't actually exist in the dataframe."""
    valid_cols = set(df.columns)
    validated = {}
    LIST_KEYS = {'sel_factors', 'text_columns', 'race_indicators'}
    for role, col in mapping.items():
        if role in LIST_KEYS and isinstance(col, list):
            good = [c for c in col if c in valid_cols]
            if good:
                validated[role] = good
        elif isinstance(col, str) and col in valid_cols:
            validated[role] = col
        # silently drop hallucinated column names
    return validated


def map_variables(df: pd.DataFrame) -> dict:
    """
    Use Claude Haiku to map every dataset column to a specific role AND generate
    a human-readable label + description for each column.

    Returns the standard mapping dict PLUS two extra keys consumed by the
    upload endpoint before being sent to the frontend:
      '_column_metadata'  - per-column {role, label, description, confidence}
      'text_columns'      - list of open-ended text columns

    Falls back to keyword matching + generated metadata if Claude fails.
    """
    columns = list(df.columns)[:30]   # cap to avoid token overflow

    # Build rich column info: name + dtype + sample values + range stats
    col_info = []
    for col in columns:
        series = df[col].dropna()
        info = {
            "name":          col,
            "dtype":         str(df[col].dtype),
            "sample_values": df[col].head(5).fillna('').astype(str).tolist(),
            "unique_count":  int(df[col].nunique()),
            "null_count":    int(df[col].isna().sum()),
        }
        if pd.api.types.is_numeric_dtype(df[col]) and len(series) > 0:
            info["min"] = float(series.min())
            info["max"] = float(series.max())
        col_info.append(info)

    prompt = f"""You are analyzing a student dataset CSV file for an education analytics tool.
For EVERY column, determine its role, a human-readable label for teachers, and a brief description.

Column details:
{json.dumps(col_info, indent=2)}

Possible roles:

CORE (used to calculate student risk scores):
  student_id        - unique student identifier (any format: integer, string, code)
  attendance        - attendance RATE as a decimal between 0.0 and 1.0 (e.g. 0.85 = 85% present).
                      ONLY use this when values are decimals between 0 and 1. If values are whole numbers, use days_absent.
  days_absent       - number of days a student was ABSENT as a raw integer count (e.g. 8, 42, 5).
                      ONLY use this when values are whole numbers greater than 1, not decimals.
  behavior          - suspension count or behavioral incident flag
  math              - math, arithmetic, algebra, or WRITING/COMPOSITION failure flag.
                      Common prefixes/keywords: math_, mth_, wr_, writ_, num_, alg_
                      (1=fail, 0=pass is common)
  english           - English, ELA, READING, or literacy failure flag.
                      Common prefixes/keywords: eng_, ela_, rd_, read_, lit_
                      (1=fail, 0=pass is common)
  failtot           - total number of courses failed (integer count)
  grade             - grade level or school year (6, 7, 8, 9, etc.)

DEMOGRAPHIC (binary 0/1 flags or category labels - NOT survey scores):
  gender            - gender or sex (M/F, 0/1, male/female, female flag)
  race_indicator    - ONE of potentially several binary race/ethnicity columns.
                      Assign this role to EACH separate race column individually.
                      Common examples: white, black, asian, hispanic, other, native, pacific
  low_ses           - socioeconomic status / free-reduced lunch flag (0/1)
  special_ed        - special education / IEP status (0/1 or Y/N)
  lep               - limited English proficiency (0/1)
  ell               - English language learner (0/1)
  parent_education  - parent education level (0/1 or ordinal)
  overage           - student is overage for their grade (0/1)
  other_demographic - any other demographic characteristic not listed above

SEL (social-emotional learning survey scores):
  sel_factor        - survey score on a numeric scale, typically 1.0-5.0 with decimals
                      and many unique values. Examples: perceived_equity, school_connectedness,
                      future_orientation, academic_engagement, adult_support, caring_adults.
                      Also includes abbreviated names like: equity, future, acdeng, connect,
                      support, acdpress, caring.

OTHER:
  text_response     - open-ended text answer (actual English sentences or multi-word phrases)
  ignore            - irrelevant, system, duplicate, or unrecognizable column

CRITICAL DISAMBIGUATION RULES (apply these strictly):
1. Binary 0/1 INTEGER columns for race/ethnicity (white, black, asian, hispanic, other, native, etc.)
   -> role MUST be "race_indicator". NEVER assign these to "sel_factor" or any other role.
2. Decimal columns with values between 1.0 and 5.0 with many unique values -> "sel_factor"
3. Columns with only values [0, 1] and unique_count of 2 -> demographic flag, not sel_factor
4. A dataset may have 5+ separate binary race columns - assign "race_indicator" to EACH one
5. If column name is a common race/ethnicity word (white, black, asian, hispanic, native, other)
   AND values are 0/1 -> always "race_indicator" regardless of column position
6. "female", "male", "sex", "gender" columns -> always "gender"
7. "ses", "frpl", "free_reduced", "low_income" columns -> always "low_ses"
8. Use BOTH sample_values AND min/max together to resolve any ambiguity
9. attendance vs days_absent: if min >= 0 and max <= 1.0 and dtype is float -> "attendance".
   If values are integers and max > 1 -> "days_absent". Never assign both to the same column.
10. math vs english: rd_/read_ prefixes = english (reading). wr_/writ_ prefixes = math (writing/composition).
    When both exist, rd_ = english, wr_ = math.
11. For race_indicator columns, the label should be just the group name:
    'Hispanic' not 'Race: Hispanic', 'Black' not 'Race: Black', 'White' not 'Race: White'.

Return a JSON object where EVERY key is a column name from the input:
{{
  "column_name": {{
    "role": "one of the exact role strings listed above",
    "label": "Human-readable name a teacher would understand (e.g. 'Hispanic', 'Attendance Rate', 'School Connectedness')",
    "description": "One sentence explaining what the values represent",
    "confidence": "high | medium | low"
  }}
}}

Return ALL {len(columns)} columns. Use "ignore" for anything that does not fit a known role."""

    try:
        response = _claude.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=2500,
            messages=[{'role': 'user', 'content': prompt}],
        )
        text = response.content[0].text.strip()
        start = text.find('{')
        end = text.rfind('}') + 1
        if start == -1 or end == 0:
            raise ValueError("No JSON object found in Claude response")

        raw = json.loads(text[start:end])

        # Keep only entries whose key is an actual column in the dataframe
        valid_cols = set(df.columns)
        column_metadata = {k: v for k, v in raw.items() if k in valid_cols}

        print(f"[map_variables] Claude mapped {len(column_metadata)}/{len(columns)} columns")

        # Build the role-keyed mapping dict for analysis functions
        mapping = _build_mapping_from_metadata(column_metadata)

        # Validate all column references actually exist
        mapping = _validate_mapping(mapping, df)

        # Attach metadata so the upload endpoint can send it to the frontend
        mapping['_column_metadata'] = column_metadata

        return mapping

    except Exception as e:
        print(f"[map_variables] Claude failed ({e}), falling back to keyword matching")
        fallback = _keyword_map_variables(df)
        fallback['_column_metadata'] = _generate_fallback_metadata(df, fallback)
        return fallback


def map_roles_from_confirmed_names(confirmed_names: dict, df: pd.DataFrame) -> dict:
    """
    After teacher confirms/edits column names, ask Claude Haiku to assign
    roles based on the confirmed human-readable name + sample values.

    confirmed_names shape:
      { "A1": "Attendance Quarter 1", "rd_q1": "Reading Score Quarter 1", ... }
      (only includes toggled-ON columns)

    Returns standard mapping dict + '_column_metadata'.
    """
    col_info = []
    for original_col, confirmed_name in confirmed_names.items():
        if original_col not in df.columns:
            continue
        series = df[original_col].dropna()
        info = {
            "original_column": original_col,
            "confirmed_name": confirmed_name,
            "dtype": str(df[original_col].dtype),
            "sample_values": df[original_col].head(5).fillna('').astype(str).tolist(),
            "unique_count": int(df[original_col].nunique()),
            "null_count": int(df[original_col].isna().sum()),
        }
        if pd.api.types.is_numeric_dtype(df[original_col]) and len(series) > 0:
            info["min"] = float(series.min())
            info["max"] = float(series.max())
        col_info.append(info)

    prompt = f"""A teacher has confirmed human-readable names for columns in a student dataset.
Your job is to assign the correct role to each column based on its confirmed name and sample values.

Columns to map:
{json.dumps(col_info, indent=2)}

Possible roles — same as before:
CORE: student_id, attendance, days_absent, behavior, math, english, failtot, grade
DEMOGRAPHIC: gender, race_indicator, low_ses, special_ed, lep, ell, parent_education, overage, other_demographic
SEL: sel_factor
OTHER: text_response, ignore

CRITICAL RULES:
1. Use the confirmed_name as the primary signal — the teacher has told you what this column means.
2. confirmed_name contains "Attendance" → attendance or days_absent (check sample values to distinguish rate vs count)
3. confirmed_name contains "Reading" or "Math" score → likely sel_factor or ignore (not math/english binary fail flag unless values are 0/1)
4. confirmed_name contains "Race" or an ethnicity name → race_indicator
5. confirmed_name contains "SEL", "Connectedness", "Equity", "Engagement" → sel_factor
6. Binary 0/1 columns whose confirmed_name is a demographic trait → appropriate demographic role
7. If confirmed_name is vague (e.g. "Quarter 1 Score") use sample values to resolve

Return ONLY valid JSON — one entry per original_column:
{{
  "original_column_name": {{
    "role": "exact role string",
    "label": "confirmed_name value — use exactly what the teacher confirmed",
    "description": "One sentence describing what the values represent",
    "confidence": "high | medium | low"
  }}
}}"""

    try:
        response = _claude.messages.create(
            model='claude-haiku-4-5-20251001',
            max_tokens=2500,
            messages=[{'role': 'user', 'content': prompt}],
        )
        text = response.content[0].text.strip()
        start = text.find('{')
        end = text.rfind('}') + 1
        if start == -1 or end == 0:
            raise ValueError("No JSON found")

        raw = json.loads(text[start:end])
        valid_cols = set(df.columns)
        column_metadata = {k: v for k, v in raw.items() if k in valid_cols}

        mapping = _build_mapping_from_metadata(column_metadata)
        mapping = _validate_mapping(mapping, df)
        mapping['_column_metadata'] = column_metadata
        return mapping

    except Exception as e:
        print(f"[map_roles_from_confirmed_names] failed ({e}), falling back to keyword matching")
        fallback = _keyword_map_variables(df)
        fallback['_column_metadata'] = _generate_fallback_metadata(df, fallback)
        return fallback


def _keyword_map_variables(df: pd.DataFrame) -> dict:
    """
    Fallback keyword-based variable detection used when Claude is unavailable.
    Handles common column naming patterns including one-hot race columns and
    abbreviated SEL names from real school datasets.
    """
    mapping = {}

    for c in df.columns:
        if c.lower() in ['student_id', 'studentid', 'student id', 'sid', 'id']:
            mapping['student_id'] = c
            break

    for c in df.columns:
        if c.lower() in ['attrate', 'attendance_rate', 'att_rate', 'attendance',
                         'present_rate', 'pct_present', 'days_present_pct', 'att']:
            mapping['attendance'] = c
            break

    # Days absent (raw count) — only if attendance rate not already found
    if 'attendance' not in mapping:
        for c in df.columns:
            if c.lower() in ['days_out', 'days_absent', 'absent_days', 'absences',
                             'days_missed', 'num_absences', 'absence_count', 'abs_count']:
                mapping['days_absent'] = c
                break

    for c in df.columns:
        if c.lower() in ['suspensions', 'suspension', 'susp', 'behavior',
                         'oss', 'oss_count', 'susp_count', 'susp_flag', 'incidents']:
            mapping['behavior'] = c
            break

    for c in df.columns:
        if c.lower() in ['math_fail', 'math_failed', 'fail_math', 'failmth',
                         'math_grade', 'math_score', 'math']:
            mapping['math'] = c
            break

    for c in df.columns:
        if c.lower() in ['eng_fail', 'eng_failed', 'fail_eng', 'faileng',
                         'ela_fail', 'ela_grade', 'ela_score', 'english', 'eng']:
            mapping['english'] = c
            break

    for c in df.columns:
        if c.lower() in ['failtot', 'fail_total', 'total_failures', 'courses_failed',
                         'num_failures', 'total_fail']:
            mapping['failtot'] = c
            break

    for c in df.columns:
        if c.lower() in ['grade', 'grade_level', 'gradelevel', 'grade_code', 'yr', 'year']:
            mapping['grade'] = c
            break

    for c in df.columns:
        if c.lower() in ['gender', 'sex', 'female', 'male', 'gender_code', 'sex_code']:
            mapping['gender'] = c
            break

    for c in df.columns:
        if c.lower() in ['special_ed', 'sped', 'speced', 'special_education',
                         'iep', 'specialed', 'special_ed_flag']:
            mapping['special_ed'] = c
            break

    for c in df.columns:
        if c.lower() in ['ell', 'english_learner', 'englishlearner', 'ell_flag']:
            mapping['ell'] = c
            break

    for c in df.columns:
        if c.lower() in ['lep', 'limited_english_proficiency', 'lep_flag']:
            mapping['lep'] = c
            break

    for c in df.columns:
        if c.lower() in ['ses', 'low_ses', 'socioeconomic_status', 'socioeconomic',
                         'frpl', 'free_reduced_lunch', 'frpl_flag', 'lowincome',
                         'low_income', 'frl']:
            mapping['low_ses'] = c
            break

    for c in df.columns:
        if c.lower() in ['pared', 'parent_ed', 'parent_education', 'parent_educ',
                         'parenteducation']:
            mapping['parent_education'] = c
            break

    for c in df.columns:
        if c.lower() in ['overage', 'over_age', 'age_flag', 'overage_flag']:
            mapping['overage'] = c
            break

    # One-hot race columns - collect ALL matches
    race_keywords = {
        'white', 'black', 'african_american', 'asian', 'hispanic', 'latino',
        'latina', 'native', 'pacific', 'multiracial', 'multi_racial', 'two_or_more',
        'other_race', 'race_white', 'race_black', 'race_hispanic', 'race_asian',
        'race_native', 'race_pacific', 'race_other', 'other',
    }
    already_mapped = set(v for v in mapping.values() if isinstance(v, str))
    race_indicators = [
        c for c in df.columns
        if c.lower() in race_keywords and c not in already_mapped
    ]
    if race_indicators:
        mapping['race_indicators'] = race_indicators

    # Single race column fallback (when not one-hot encoded)
    if 'race_indicators' not in mapping:
        for c in df.columns:
            if c.lower() in ['race', 'race_ethnicity', 'student_race', 'race_code',
                             'ethnicity', 'ethnic_group']:
                mapping['race'] = c
                break

    # SEL factors - full names and common abbreviations
    sel_keywords = {
        'perceived_equity', 'future_orientation', 'academic_engagement',
        'school_connectedness', 'adult_support', 'academic_pressure', 'caring_adults',
        'belonging', 'motivation', 'self_regulation', 'social_awareness', 'self_efficacy',
        # Common abbreviations seen in real data
        'equity', 'future', 'acdeng', 'connect', 'support', 'acdpress', 'caring',
        'selfeff', 'socaware', 'belong', 'motiv', 'selfreg',
    }
    found_sel = [c for c in df.columns if c.lower() in sel_keywords]

    # Also detect by value heuristic: numeric 1-5 scale with decimals
    already_mapped_all = set(v for v in mapping.values() if isinstance(v, str))
    if 'race_indicators' in mapping:
        already_mapped_all.update(mapping['race_indicators'])
    for c in df.columns:
        if c in already_mapped_all or c in found_sel:
            continue
        if pd.api.types.is_numeric_dtype(df[c]):
            col_min = df[c].min()
            col_max = df[c].max()
            n_unique = df[c].nunique()
            if (
                not pd.isna(col_min) and not pd.isna(col_max)
                and 1.0 <= col_min and col_max <= 5.5
                and n_unique > 5
                and df[c].dtype in [float, 'float64', 'float32']
            ):
                found_sel.append(c)

    if found_sel:
        mapping['sel_factors'] = found_sel

    return mapping


# ---------------------------------------------------------------------------
# Risk flag calculation
# ---------------------------------------------------------------------------

def _letter_grade_base(grade_str: str) -> Optional[str]:
    if grade_str is None or (isinstance(grade_str, float) and pd.isna(grade_str)):
        return None
    s = str(grade_str).strip().upper()
    if not s:
        return None
    for ch in s:
        if ch.isalpha():
            return ch
    return None


def _is_failing_letter(value, letter_rule: str = "F_only") -> bool:
    base = _letter_grade_base(value)
    if not base:
        return False
    if letter_rule == "D_or_below":
        return base in {"D", "F", "E", "U", "I"}
    return base == "F" or base in {"E", "U", "I"}


def _course_fail_mask(series: pd.Series, rule: dict) -> pd.Series:
    fmt = (rule or {}).get("format", "binary")
    if fmt == "letter":
        lr = (rule or {}).get("letter_rule", "F_only")
        return series.map(lambda v: _is_failing_letter(v, lr))
    if fmt == "numeric":
        cutoff = float((rule or {}).get("numeric_below", 60))
        nums = pd.to_numeric(series, errors="coerce")
        return nums < cutoff
    if fmt == "count":
        min_count = float((rule or {}).get("min_count", 1))
        nums = pd.to_numeric(series, errors="coerce")
        return nums >= min_count
    # binary fail flag
    nums = pd.to_numeric(series, errors="coerce")
    return nums >= 1


def _legacy_course_rules(mapping: dict) -> list:
    rules = []
    for key, label in (("math", "Math"), ("english", "English")):
        if key in mapping and mapping[key]:
            rules.append({"key": key, "column": mapping[key], "format": "binary", "label": label})
    if "failtot" in mapping and mapping["failtot"]:
        rules.append({
            "key": "failtot",
            "column": mapping["failtot"],
            "format": "count",
            "min_count": 1,
            "label": "Total courses failed",
        })
    return rules


def _apply_academic_failure(df: pd.DataFrame, mapping: dict, t: dict) -> pd.Series:
    rules = t.get("course_rules")
    if not rules:
        rules = _legacy_course_rules(mapping)

    min_courses = int(t.get("academic_min_courses", 1) or 1)
    masks = []
    for rule in rules:
        col = rule.get("column") or mapping.get(rule.get("key"))
        if not col or col not in df.columns:
            continue
        masks.append(_course_fail_mask(df[col], rule))

    if not masks:
        return pd.Series(False, index=df.index)

    fail_matrix = pd.concat(masks, axis=1)
    if min_courses <= 1:
        return fail_matrix.any(axis=1)
    return fail_matrix.sum(axis=1) >= min_courses


def _behavior_description(t: dict) -> str:
    n = int(t.get("suspension_min", 1) or 1)
    return f"{n} or more suspension{'s' if n != 1 else ''}"


def _academic_description(t: dict) -> str:
    min_c = int(t.get("academic_min_courses", 1) or 1)
    preset = t.get("academic_preset")
    if preset == "fail_f_in_2":
        return "Fail (F) in 2 or more courses"
    if preset == "fail_d_in_1":
        return "Grade D or below in 1 or more courses"
    if preset == "failtot_min":
        return "Failed 1 or more courses (count)"
    if preset == "binary_any":
        return "Fail flag in 1 or more courses"
    if min_c > 1:
        return f"Failing criteria met in {min_c}+ courses"
    return "Failing 1 or more courses per your criteria"


def calculate_risk_flags(df: pd.DataFrame, mapping: dict, thresholds: dict = None) -> pd.DataFrame:
    """Add risk flag columns to dataframe. Called by every analysis stage."""
    t = {**DEFAULTS, **(thresholds or {})}
    df = df.copy()

    total_days = int(t.get("total_school_days", 180) or 180)
    basis = t.get("absence_basis", "rate")
    use_days = basis == "days" and "days_absent" in mapping and mapping["days_absent"] in df.columns
    use_rate = (
        not use_days
        and "attendance" in mapping
        and mapping["attendance"] in df.columns
    )

    if use_rate:
        att = mapping["attendance"]
        missed = 1 - df[att]
        df["days_missed_pct"] = (missed * 100).round(1)
        df["chronic_absent"] = missed >= t["chronic_absence_threshold"]
        df["severe_absent"] = missed >= t["severe_absence_threshold"]
    elif "days_absent" in mapping and mapping["days_absent"] in df.columns:
        absent_col = mapping["days_absent"]
        ratio = df[absent_col] / total_days
        df["days_missed_pct"] = (ratio * 100).round(1)
        df["chronic_absent"] = ratio >= t["chronic_absence_threshold"]
        df["severe_absent"] = ratio >= t["severe_absence_threshold"]
    else:
        df["chronic_absent"] = False
        df["severe_absent"] = False
        df["days_missed_pct"] = 0.0

    susp_min = float(t.get("suspension_min", 1) or 1)
    if "behavior" in mapping and mapping["behavior"] in df.columns:
        df["has_suspension"] = pd.to_numeric(df[mapping["behavior"]], errors="coerce").fillna(0) >= susp_min
    else:
        df["has_suspension"] = False

    df["has_academic_failure"] = _apply_academic_failure(df, mapping, t)

    # Flag count (0-3)
    df['flag_count'] = (
        df['chronic_absent'].astype(int) +
        df['has_suspension'].astype(int) +
        df['has_academic_failure'].astype(int)
    )

    # Normalise student IDs for display
    sid_col = mapping.get('student_id')
    if sid_col and sid_col in df.columns:
        df[sid_col] = df[sid_col].map(_normalize_student_id_display)

    return df


# ---------------------------------------------------------------------------
# Unified foundational analysis (individual + overlap)
# ---------------------------------------------------------------------------

def run_unified_analysis(df: pd.DataFrame, mapping: dict, thresholds: dict = None) -> dict:
    """
    Unified foundational analysis:
      - individual indicator counts + grade breakdowns
      - overlap/intersection counts in the same payload
    """
    t = {**DEFAULTS, **(thresholds or {})}
    thresholds_used = {**t}
    thresholds_used["course_failure_label"] = _academic_description(t)
    df = calculate_risk_flags(df, mapping, thresholds)
    df["indicator_count"] = df["flag_count"]

    total = len(df)
    grade_col = mapping.get("grade")

    def grade_breakdown(mask):
        if not grade_col or grade_col not in df.columns:
            return {}
        out = {}
        for grade, grp in df[mask].groupby(df[grade_col]):
            out[str(grade)] = int(len(grp))
        return out

    result = {
        "total": total,
        "thresholds_used": thresholds_used,
        "indicators": {
            "attendance": {
                "label": "Chronically Absent",
                "description": f"Missing {int(t['chronic_absence_threshold'] * 100)}%+ of school days",
                "count": int(df["chronic_absent"].sum()),
                "pct": round(df["chronic_absent"].mean() * 100, 1) if total else 0,
                "by_grade": grade_breakdown(df["chronic_absent"]),
                "severe": {
                    "label": "Severely Absent",
                    "description": f"Missing {int(t['severe_absence_threshold'] * 100)}%+ of school days",
                    "count": int(df["severe_absent"].sum()),
                    "pct": round(df["severe_absent"].mean() * 100, 1) if total else 0,
                    "by_grade": grade_breakdown(df["severe_absent"]),
                },
            },
            "behavior": {
                "label": "Suspended",
                "description": _behavior_description(t),
                "count": int(df["has_suspension"].sum()),
                "pct": round(df["has_suspension"].mean() * 100, 1) if total else 0,
                "by_grade": grade_breakdown(df["has_suspension"]),
            },
            "academic": {
                "label": "Failing Courses",
                "description": _academic_description(t),
                "count": int(df["has_academic_failure"].sum()),
                "pct": round(df["has_academic_failure"].mean() * 100, 1) if total else 0,
                "by_grade": grade_breakdown(df["has_academic_failure"]),
            },
        },
        "overlap": {
            "two_or_more": {
                "count": int((df["indicator_count"] >= 2).sum()),
                "pct": round((df["indicator_count"] >= 2).mean() * 100, 1) if total else 0,
                "by_grade": grade_breakdown(df["indicator_count"] >= 2),
            },
            "all_three": {
                "count": int((df["indicator_count"] == 3).sum()),
                "pct": round((df["indicator_count"] == 3).mean() * 100, 1) if total else 0,
                "by_grade": grade_breakdown(df["indicator_count"] == 3),
            },
            "combinations": {
                "absent_only": int((df["chronic_absent"] & ~df["has_suspension"] & ~df["has_academic_failure"]).sum()),
                "behavior_only": int((df["has_suspension"] & ~df["chronic_absent"] & ~df["has_academic_failure"]).sum()),
                "academic_only": int((df["has_academic_failure"] & ~df["chronic_absent"] & ~df["has_suspension"]).sum()),
                "absent_behavior": int((df["chronic_absent"] & df["has_suspension"] & ~df["has_academic_failure"]).sum()),
                "absent_academic": int((df["chronic_absent"] & df["has_academic_failure"] & ~df["has_suspension"]).sum()),
                "behavior_academic": int((df["has_suspension"] & df["has_academic_failure"] & ~df["chronic_absent"]).sum()),
                "all_three": int((df["indicator_count"] == 3).sum()),
            },
        },
    }

    if grade_col and grade_col in df.columns:
        grade_summary = {}
        for grade, grp in df.groupby(grade_col):
            n = len(grp)
            grade_summary[str(grade)] = {
                "total": int(n),
                "absent_count": int(grp["chronic_absent"].sum()),
                "absent_pct": round(grp["chronic_absent"].mean() * 100, 1) if n else 0,
                "severe_count": int(grp["severe_absent"].sum()),
                "suspended_count": int(grp["has_suspension"].sum()),
                "suspended_pct": round(grp["has_suspension"].mean() * 100, 1) if n else 0,
                "failing_count": int(grp["has_academic_failure"].sum()),
                "failing_pct": round(grp["has_academic_failure"].mean() * 100, 1) if n else 0,
                "two_plus_count": int((grp["indicator_count"] >= 2).sum()),
                "two_plus_pct": round((grp["indicator_count"] >= 2).mean() * 100, 1) if n else 0,
                "all_three_count": int((grp["indicator_count"] == 3).sum()),
                "combinations": {
                    "absent_only":        int((grp["chronic_absent"] & ~grp["has_suspension"] & ~grp["has_academic_failure"]).sum()),
                    "behavior_only":      int((grp["has_suspension"] & ~grp["chronic_absent"] & ~grp["has_academic_failure"]).sum()),
                    "academic_only":      int((grp["has_academic_failure"] & ~grp["chronic_absent"] & ~grp["has_suspension"]).sum()),
                    "absent_behavior":    int((grp["chronic_absent"] & grp["has_suspension"] & ~grp["has_academic_failure"]).sum()),
                    "absent_academic":    int((grp["chronic_absent"] & grp["has_academic_failure"] & ~grp["has_suspension"]).sum()),
                    "behavior_academic":  int((grp["has_suspension"] & grp["has_academic_failure"] & ~grp["chronic_absent"]).sum()),
                    "all_three":          int((grp["indicator_count"] == 3).sum()),
                },
            }
        result["grade_summary"] = grade_summary

    return result


def run_individual_risk(df: pd.DataFrame, mapping: dict, thresholds: dict = None) -> dict:
    """Compatibility wrapper: foundational view now comes from unified analysis."""
    return run_unified_analysis(df, mapping, thresholds)


# ---------------------------------------------------------------------------
# Stage 2: Intersection analysis
# ---------------------------------------------------------------------------

def run_intersection_analysis(df: pd.DataFrame, mapping: dict, thresholds: dict = None) -> dict:
    """Compatibility wrapper: overlap is now returned by run_unified_analysis()."""
    return run_unified_analysis(df, mapping, thresholds).get("overlap", {})


# ---------------------------------------------------------------------------
# Subgroup analysis
# ---------------------------------------------------------------------------

# Equity note: flag when share of school-wide "all 3 flags" students attributed to this group
# exceeds this multiple of the group's share of enrollment (was 1.5; 2.0 reduces borderline noise).
SUBGROUP_EQUITY_RATIO_THRESHOLD = 2.0


def _subgroup_indicator_breakdown(sub: pd.DataFrame) -> Optional[dict]:
    """Per demographic group: single-flag and combination counts (% of that group)."""
    n = len(sub)
    if n == 0:
        return None

    ca = sub["chronic_absent"]
    sus = sub["has_suspension"]
    acad = sub["has_academic_failure"]

    single_flags = [
        {"label": "Absent only", "tags": ["absent"], "count": int((ca & ~sus & ~acad).sum())},
        {"label": "Suspended only", "tags": ["behavior"], "count": int((sus & ~ca & ~acad).sum())},
        {"label": "Academic failure only", "tags": ["academic"], "count": int((acad & ~ca & ~sus).sum())},
    ]
    combinations = [
        {"label": "Abs + Fail", "tags": ["absent", "academic"], "count": int((ca & acad & ~sus).sum())},
        {"label": "Sus + Fail", "tags": ["behavior", "academic"], "count": int((sus & acad & ~ca).sum())},
        {"label": "Abs + Sus", "tags": ["absent", "behavior"], "count": int((ca & sus & ~acad).sum())},
    ]
    all_three_count = int((ca & sus & acad).sum())
    flagged_count = int((ca | sus | acad).sum())
    academic_fail_count = int(acad.sum())
    chronic_absent_count = int(ca.sum())
    suspended_count = int(sus.sum())
    if "flag_count" in sub.columns:
        two_or_more_count = int((sub["flag_count"] >= 2).sum())
    else:
        two_or_more_count = int((ca & acad).sum() + (ca & sus).sum() + (sus & acad).sum()) + all_three_count

    single_flags = [r for r in single_flags if r["count"] > 0]
    combinations = [r for r in combinations if r["count"] > 0]

    for r in single_flags + combinations:
        r["pct"] = round(r["count"] / n * 100, 1)

    return {
        "n": n,
        "flagged_count": flagged_count,
        "flagged_pct": round(flagged_count / n * 100, 1),
        "academic_fail_count": academic_fail_count,
        "cohort_pct": round(academic_fail_count / n * 100, 1),
        "chronic_absent_count": chronic_absent_count,
        "chronic_absent_pct": round(chronic_absent_count / n * 100, 1),
        "suspended_count": suspended_count,
        "suspended_pct": round(suspended_count / n * 100, 1),
        "two_or_more_count": two_or_more_count,
        "two_or_more_pct": round(two_or_more_count / n * 100, 1),
        "single_flags": single_flags,
        "combinations": combinations,
        "all_three": {"count": all_three_count, "pct": round(all_three_count / n * 100, 1)},
        "all_three_pct": round(all_three_count / n * 100, 1),
    }


def run_subgroup_analysis(df: pd.DataFrame, mapping: dict, thresholds: dict = None, column_metadata: dict = None) -> dict:
    """School-wide demographic comparison (course failure, chronic absence, overlap per group)."""
    total = len(df)
    df = calculate_risk_flags(df.copy(), mapping, thresholds)
    print(f"[subgroup debug] has_academic_failure sum={df['has_academic_failure'].sum()} total={len(df)}")
    print(f"[subgroup debug] thresholds={thresholds}")
    print(f"[subgroup debug] course_rules={thresholds.get('course_rules') if thresholds else None}")
    df["indicator_count"] = df["flag_count"]

    def group_breakdown(mask):
        """Given a boolean mask selecting a subgroup, compute single/combo/all3 counts."""
        return _subgroup_indicator_breakdown(df[mask])

    def pct_of_all3(mask):
        all3_total = int((df["flag_count"] == 3).sum())
        if all3_total == 0:
            return 0
        return round((df[mask & (df["flag_count"] == 3)].shape[0]) / all3_total * 100, 1)

    categories = []

    race_cols = mapping.get("race_indicators", [])
    if race_cols:
        race_groups = []

        for col in race_cols:
            if col not in df.columns:
                continue
            if df[col].dtype == object or df[col].nunique() > 2:
                for val in sorted(df[col].dropna().unique()):
                    mask = df[col] == val
                    bd = group_breakdown(mask)
                    if bd:
                        bd["name"] = str(val)
                        bd["school_pct"] = round(mask.sum() / total * 100, 1) if total else 0
                        bd["all3_school_pct"] = pct_of_all3(mask)
                        race_groups.append(bd)
            else:
                mask = df[col] == 1
                bd = group_breakdown(mask)
                if bd:
                    bd["name"] = (column_metadata or {}).get(col, {}).get('label') or col.replace("_", " ").title()
                    bd["school_pct"] = round(mask.sum() / total * 100, 1) if total else 0
                    bd["all3_school_pct"] = pct_of_all3(mask)
                    race_groups.append(bd)

        equity_notes = []
        for g in race_groups:
            if g.get("all3_school_pct", 0) > g.get("school_pct", 0) * SUBGROUP_EQUITY_RATIO_THRESHOLD:
                equity_notes.append(
                    f"{g['name']} students represent {g['school_pct']}% of the school "
                    f"but {g['all3_school_pct']}% of students with all 3 flags."
                )

        if race_groups:
            categories.append({
                "tab_label": "Race / ethnicity",
                "groups": race_groups,
                "equity_note": " ".join(equity_notes) or None,
            })

    def add_binary_category(tab_label, col, label_1, label_0=None):
        if not col or col not in df.columns:
            return
        unique_vals = df[col].dropna().unique()
        groups = []

        if df[col].dtype == object or df[col].nunique() > 2:
            for val in sorted(unique_vals):
                mask = df[col] == val
                bd = group_breakdown(mask)
                if bd:
                    bd["name"] = str(val)
                    bd["school_pct"] = round(mask.sum() / total * 100, 1) if total else 0
                    bd["all3_school_pct"] = pct_of_all3(mask)
                    groups.append(bd)
        else:
            mask1 = df[col] == 1
            bd1 = group_breakdown(mask1)
            if bd1:
                bd1["name"] = label_1
                bd1["school_pct"] = round(mask1.sum() / total * 100, 1) if total else 0
                bd1["all3_school_pct"] = pct_of_all3(mask1)
                groups.append(bd1)
            if label_0:
                mask0 = df[col] == 0
                bd0 = group_breakdown(mask0)
                if bd0:
                    bd0["name"] = label_0
                    bd0["school_pct"] = round(mask0.sum() / total * 100, 1) if total else 0
                    bd0["all3_school_pct"] = pct_of_all3(mask0)
                    groups.append(bd0)

        if groups:
            equity_notes = [
                f"{g['name']} students represent {g['school_pct']}% of the school "
                f"but {g['all3_school_pct']}% of students with all 3 flags."
                for g in groups
                if g.get("all3_school_pct", 0) > g.get("school_pct", 0) * SUBGROUP_EQUITY_RATIO_THRESHOLD
            ]
            categories.append({
                "tab_label": tab_label,
                "groups": groups,
                "equity_note": " ".join(equity_notes) or None,
            })

    add_binary_category("Gender", mapping.get("gender"), "Female", "Male")
    add_binary_category("SPED status", mapping.get("special_ed"), "Special Ed (IEP)", "No IEP")
    add_binary_category("ELL status", mapping.get("ell") or mapping.get("lep"), "ELL", "Non-ELL")
    add_binary_category("Low SES", mapping.get("low_ses"), "Low SES", "Not low SES")

    # Detect pre-filtered cohort — if cohort_pct > 90% across all race groups,
    # the dataframe was already filtered to a risk cohort and metrics are meaningless
    race_groups_flat = categories[0]["groups"] if categories else []
    warning = None
    if race_groups_flat:
        high_rate_count = sum(
            1 for g in race_groups_flat
            if isinstance(g, dict) and float(g.get("cohort_pct", 0)) > 0.9
        )
        if high_rate_count == len(race_groups_flat):
            warning = (
                "These rates reflect a pre-filtered cohort where all students already "
                "share the same risk indicators — course failure and chronic absence "
                "rates will be 100% across all groups and are not meaningful for comparison. "
                "Use the school-wide subgroup breakdown for equity analysis."
            )

    return {
        "mode": "school_wide",
        "total": total,
        "categories": categories,
        "warning": warning,
    }


def _triple_cohort_slice_detail(
    sub: pd.DataFrame, mapping: dict, thresholds: dict = None
) -> tuple[list, list]:
    """Intensity metrics within a triple-flag demographic slice (for accordion detail)."""
    n = len(sub)
    if n == 0:
        return [], []
    t = {**DEFAULTS, **(thresholds or {})}
    susp_min = int(float(t.get("suspension_min", 1) or 1))
    combos: list = []

    if "severe_absent" in sub.columns:
        c = int(sub["severe_absent"].sum())
        if c:
            combos.append({
                "label": "Severely absent (20%+ days missed)",
                "tags": ["absent"],
                "count": c,
                "pct": round(c / n * 100, 1),
            })

    beh = mapping.get("behavior")
    if beh and beh in sub.columns:
        susp = pd.to_numeric(sub[beh], errors="coerce").fillna(0)
        c = int((susp >= max(2, susp_min + 1)).sum())
        if c:
            combos.append({
                "label": "2+ suspensions",
                "tags": ["behavior"],
                "count": c,
                "pct": round(c / n * 100, 1),
            })

    failtot = mapping.get("failtot")
    if failtot and failtot in sub.columns:
        fails = pd.to_numeric(sub[failtot], errors="coerce").fillna(0)
        c = int((fails >= 3).sum())
        if c:
            combos.append({
                "label": "3+ course failures",
                "tags": ["academic"],
                "count": c,
                "pct": round(c / n * 100, 1),
            })

    return [], combos


def run_triple_flag_cohort_subgroup(
    df: pd.DataFrame, mapping: dict, thresholds: dict = None, column_metadata: dict = None
) -> dict:
    """
    Composition of students with all 3 risk flags, broken down by demographic.
    Percentages are share of the triple-flag cohort (not school-wide flagged rates).
    """
    df = calculate_risk_flags(df, mapping, thresholds)
    school_total = len(df)
    cohort = df[df["flag_count"] == 3].copy()
    cohort_total = len(cohort)

    def cohort_group(name: str, sub: pd.DataFrame) -> dict:
        count = len(sub)
        pct = round(count / cohort_total * 100, 1) if cohort_total else 0
        _single, combinations = _triple_cohort_slice_detail(sub, mapping, thresholds)
        return {
            "name": name,
            "n": count,
            "flagged_count": count,
            "flagged_pct": pct,
            "cohort_pct": pct,
            "single_flags": _single,
            "combinations": combinations,
            "all_three": {"count": count, "pct": 100.0 if count else 0},
        }

    categories: list = []

    def add_cohort_category(tab_label: str, groups: list) -> None:
        if not groups:
            return
        top = max(groups, key=lambda g: g.get("cohort_pct", 0))
        note = (
            f"{top['name']} is the largest share of this cohort "
            f"({top['cohort_pct']}% of {cohort_total} triple-flag students)."
            if cohort_total and top.get("cohort_pct", 0) > 0
            else None
        )
        categories.append({
            "tab_label": tab_label,
            "groups": sorted(groups, key=lambda g: g.get("cohort_pct", 0), reverse=True),
            "equity_note": note,
        })

    race_cols = mapping.get("race_indicators") or []
    race_groups = []
    for col in race_cols:
        if col not in cohort.columns:
            continue
        if cohort[col].dtype == object or cohort[col].nunique() > 2:
            for val in sorted(cohort[col].dropna().unique()):
                mask = cohort[col] == val
                if int(mask.sum()):
                    race_groups.append(cohort_group(str(val), cohort[mask]))
        else:
            mask = cohort[col] == 1
            if int(mask.sum()):
                race_groups.append(cohort_group(
                    (column_metadata or {}).get(col, {}).get('label') or col.replace("_", " ").title(),
                    cohort[mask],
                ))
    add_cohort_category("Race / ethnicity", race_groups)

    def add_binary_cohort(tab_label: str, col, label_1: str, label_0: str = None) -> None:
        if not col or col not in cohort.columns:
            return
        groups = []
        if cohort[col].dtype == object or cohort[col].nunique() > 2:
            for val in sorted(cohort[col].dropna().unique()):
                mask = cohort[col] == val
                if int(mask.sum()):
                    groups.append(cohort_group(str(val), cohort[mask]))
        else:
            mask1 = cohort[col] == 1
            if int(mask1.sum()):
                groups.append(cohort_group(label_1, cohort[mask1]))
            if label_0 is not None:
                mask0 = cohort[col] == 0
                if int(mask0.sum()):
                    groups.append(cohort_group(label_0, cohort[mask0]))
        add_cohort_category(tab_label, groups)

    add_binary_cohort("Gender", mapping.get("gender"), "Female", "Male")
    add_binary_cohort("SPED status", mapping.get("special_ed"), "Special Ed (IEP)", "No IEP")
    add_binary_cohort("ELL status", mapping.get("ell") or mapping.get("lep"), "ELL", "Non-ELL")
    add_binary_cohort("Low SES", mapping.get("low_ses"), "Low SES", "Not low SES")

    return {
        "mode": "triple_flag_cohort",
        "total": school_total,
        "cohort_total": cohort_total,
        "categories": categories,
    }


def run_grade_subgroup_driver_analysis(
    df: pd.DataFrame,
    mapping: dict,
    thresholds: dict = None,
    grade: str = None,
    column_metadata: dict = None,
) -> dict:
    """
    Within one grade, show academic failure rate by demographic subgroup.
    Percentages are % of that subgroup in the grade who have academic failure.
    """
    df = calculate_risk_flags(df, mapping, thresholds)
    school_total = len(df)
    grade_col = mapping.get("grade")
    grade_key = str(grade or "").strip().replace("Grade ", "")
    if not grade_col or grade_col not in df.columns or not grade_key:
        return {
            "mode": "grade_subgroup",
            "grade": grade_key or None,
            "total": school_total,
            "grade_total": 0,
            "categories": [],
        }

    grade_df = df[df[grade_col].astype(str) == grade_key].copy()
    grade_total = len(grade_df)
    if grade_total == 0:
        return {
            "mode": "grade_subgroup",
            "grade": grade_key,
            "total": school_total,
            "grade_total": 0,
            "categories": [],
        }

    def driver_group(name: str, mask) -> Optional[dict]:
        bd = _subgroup_indicator_breakdown(grade_df[mask])
        if not bd:
            return None
        bd["name"] = name
        return bd

    categories: list = []

    def add_grade_category(tab_label: str, groups: list) -> None:
        if not groups:
            return
        top = max(groups, key=lambda g: g.get("cohort_pct", 0))
        note = (
            f"{top['name']} has the highest academic failure rate in Grade {grade_key} "
            f"({top['cohort_pct']}% of {top['n']} students in that group)."
            if top.get("n", 0) > 0
            else None
        )
        categories.append({
            "tab_label": tab_label,
            "groups": sorted(groups, key=lambda g: g.get("cohort_pct", 0), reverse=True),
            "equity_note": note,
        })

    race_cols = mapping.get("race_indicators") or []
    race_groups = []
    for col in race_cols:
        if col not in grade_df.columns:
            continue
        if grade_df[col].dtype == object or grade_df[col].nunique() > 2:
            for val in sorted(grade_df[col].dropna().unique()):
                mask = grade_df[col] == val
                n = int(mask.sum())
                if n:
                    g = driver_group(str(val), mask)
                    if g:
                        race_groups.append(g)
        else:
            mask = grade_df[col] == 1
            if int(mask.sum()):
                g = driver_group(
                    (column_metadata or {}).get(col, {}).get('label') or col.replace("_", " ").title(),
                    mask,
                )
                if g:
                    race_groups.append(g)
    add_grade_category("Race / ethnicity", race_groups)

    def add_binary_grade(tab_label: str, col, label_1: str, label_0: str = None) -> None:
        if not col or col not in grade_df.columns:
            return
        groups = []
        if grade_df[col].dtype == object or grade_df[col].nunique() > 2:
            for val in sorted(grade_df[col].dropna().unique()):
                mask = grade_df[col] == val
                n = int(mask.sum())
                if n:
                    g = driver_group(str(val), mask)
                    if g:
                        groups.append(g)
        else:
            mask1 = grade_df[col] == 1
            if int(mask1.sum()):
                g = driver_group(label_1, mask1)
                if g:
                    groups.append(g)
            if label_0 is not None:
                mask0 = grade_df[col] == 0
                if int(mask0.sum()):
                    g = driver_group(label_0, mask0)
                    if g:
                        groups.append(g)
        add_grade_category(tab_label, groups)

    add_binary_grade("Gender", mapping.get("gender"), "Female", "Male")
    add_binary_grade("SPED status", mapping.get("special_ed"), "Special Ed (IEP)", "No IEP")
    add_binary_grade("ELL status", mapping.get("ell") or mapping.get("lep"), "ELL", "Non-ELL")
    add_binary_grade("Low SES", mapping.get("low_ses"), "Low SES", "Not low SES")

    return {
        "mode": "grade_subgroup",
        "grade": grade_key,
        "total": school_total,
        "grade_total": grade_total,
        "categories": categories,
    }


# ---------------------------------------------------------------------------
# Stage 3: SEL factor analysis
# ---------------------------------------------------------------------------

SEL_DEMO_LABELS = {
    "low_ses": ("Low SES", "Not low SES"),
    "special_ed": ("Special Ed (IEP)", "No IEP"),
    "ell": ("ELL", "Non-ELL"),
}


def _demographic_yes_mask(series: pd.Series) -> pd.Series:
    """True where a 0/1 or yes/no demographic flag is 'yes'."""
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().sum() >= max(1, len(series) // 4):
        return numeric.fillna(0).astype(int) == 1
    lowered = series.astype(str).str.strip().str.lower()
    return lowered.isin({"1", "yes", "y", "true", "ell", "sped", "iep"})


def _normalize_sel_cohort(cohort: Optional[str]) -> Optional[str]:
    if not cohort:
        return None
    c = str(cohort).strip().lower()
    if c in ("triple", "triple_flag", "all_three", "critical", "all3", "all_3"):
        return "triple_flag"
    return None


def _sel_focus_label(tier_key: str, grade_key: Optional[str]) -> str:
    labels = {
        "triple_flag": "all three risk indicators",
    }
    base = labels.get(tier_key, tier_key.replace("_", " "))
    if grade_key:
        return f"Grade {grade_key} students with {base}"
    return f"Students with {base}"


def _sel_focus_mask(df: pd.DataFrame, tier_key: str) -> pd.Series:
    if tier_key == "triple_flag":
        return df["flag_count"] == 3
    return pd.Series(False, index=df.index)


def _sel_group_payload(group_df: pd.DataFrame, sel_cols: list, overall_avg: dict) -> dict:
    group_avg = group_df[sel_cols].mean()
    gaps = {
        col: round(((group_avg[col] - overall_avg[col]) / overall_avg[col]) * 100, 1)
        for col in sel_cols
        if overall_avg.get(col, 0) != 0
    }
    return {
        "n": len(group_df),
        "averages": {k: round(v, 2) for k, v in group_avg.items()},
        "gaps_pct": gaps,
        "biggest_gap": min(gaps, key=gaps.get) if gaps else None,
        "smallest_gap": max(gaps, key=gaps.get) if gaps else None,
    }


def run_sel_analysis(
    df: pd.DataFrame,
    mapping: dict,
    thresholds: dict = None,
    cohort: Optional[str] = None,
    cohort_grade: Optional[str] = None,
    baseline: Optional[str] = None,
    compare_grades: Optional[list] = None,
    compare_dimension: Optional[str] = None,
    compare_grade: Optional[str] = None,
    custom_groups: Optional[list] = None,
) -> dict:
    """Stage 3: Compare SEL scores across at-risk groups vs class average."""
    # Custom group comparison — delegate to run_group_comparison
    if custom_groups and len(custom_groups) >= 1:
        return run_group_comparison(
            df=df,
            mapping=mapping,
            groups=custom_groups,
            metric="sel",
            thresholds=thresholds,
        )
    if 'sel_factors' not in mapping:
        return {"available": False}

    df = calculate_risk_flags(df, mapping, thresholds)
    df["indicator_count"] = df["flag_count"]
    sel_cols = [c for c in mapping['sel_factors'] if c in df.columns]
    if not sel_cols:
        return {"available": False}
    column_metadata = mapping.get('_column_metadata') or {}
    factor_labels = {
        col: column_metadata.get(col, {}).get('label') or col.replace('_', ' ').title()
        for col in sel_cols
    }

    # Drop rows where ALL SEL cols are NaN (students who didn't complete the survey)
    sel_df = df.dropna(subset=sel_cols, how='all')
    overall_avg = sel_df[sel_cols].mean().to_dict()
    print(f"[sel debug] sel_cols={sel_cols}")
    print(f"[sel debug] df rows={len(df)} sel_df rows after dropna={len(sel_df)}")
    print(f"[sel debug] sample sel values: {df[sel_cols].head(3).to_dict()}")
    print(f"[sel debug] null counts: {df[sel_cols].isnull().sum().to_dict()}")

    dim_key = (compare_dimension or "").strip().lower()
    grade_key = str(compare_grade or "").strip().replace("Grade ", "")
    if dim_key in SEL_DEMO_LABELS and grade_key:
        col = mapping.get(dim_key)
        if dim_key == "ell" and not col:
            col = mapping.get("lep")
        grade_col = mapping.get("grade")
        if not col or col not in df.columns or not grade_col or grade_col not in df.columns:
            return {"available": False, "reason": "missing_demographic_or_grade_column"}

        grade_mask = df[grade_col].astype(str) == grade_key
        grade_all = df[grade_mask]
        grade_sel = sel_df[grade_mask]
        if len(grade_sel) == 0:
            return {"available": False, "reason": "no_sel_in_grade"}

        grade_avg = grade_sel[sel_cols].mean().to_dict()
        yes_lbl, no_lbl = SEL_DEMO_LABELS[dim_key]
        yes_mask_sel = _demographic_yes_mask(grade_sel[col])
        yes_mask_all = _demographic_yes_mask(grade_all[col])
        groups: dict = {}

        def _flag_rate_pct(sub: pd.DataFrame) -> float:
            if len(sub) == 0:
                return 0.0
            return round((sub["flag_count"] >= 1).mean() * 100, 1)

        for key_suffix, sel_mask, all_mask, label in (
            ("no", ~yes_mask_sel, ~yes_mask_all, no_lbl),
            ("yes", yes_mask_sel, yes_mask_all, yes_lbl),
        ):
            sub = grade_sel[sel_mask]
            if len(sub) == 0:
                continue
            sub_all = grade_all[all_mask]
            payload = _sel_group_payload(sub, sel_cols, grade_avg)
            payload["label"] = label
            payload["flagged_pct"] = _flag_rate_pct(sub_all)
            groups[f"{dim_key}_{key_suffix}"] = payload

        if len(groups) < 2:
            return {"available": False, "reason": "insufficient_demographic_groups"}

        default_key = f"{dim_key}_yes" if f"{dim_key}_yes" in groups else next(iter(groups))
        yes_flag = groups.get(f"{dim_key}_yes", {}).get("flagged_pct")
        return {
            "available": True,
            "mode": "demographic_compare",
            "focused": True,
            "factor_labels": factor_labels,
            "dimension": dim_key,
            "grade": grade_key,
            "default_group": default_key,
            "overall_avg": {k: round(v, 2) for k, v in grade_avg.items()},
            "overall_label": f"Grade {grade_key} average",
            "groups": groups,
            "context_note": (
                f"In Grade {grade_key}, {yes_lbl} students have a {yes_flag}% rate of at least one risk flag."
                if yes_flag is not None
                else None
            ),
        }

    if compare_grades:
        grade_col = mapping.get("grade")
        if not grade_col or grade_col not in df.columns:
            return {"available": False, "reason": "no_grade_column"}

        groups: dict = {}
        normalized: list = []
        for raw in compare_grades:
            gk = str(raw).strip().replace("Grade ", "")
            if not gk:
                continue
            mask = sel_df[grade_col].astype(str) == gk
            if not int(mask.sum()):
                continue
            key = f"grade_{gk}"
            payload = _sel_group_payload(sel_df[mask], sel_cols, overall_avg)
            payload["grade"] = gk
            payload["label"] = f"Grade {gk}"
            groups[key] = payload
            normalized.append(gk)

        if not groups:
            return {"available": False, "reason": "no_grade_sel_data"}

        normalized.sort(key=lambda x: int(x) if str(x).isdigit() else x)
        default_g = normalized[-1]
        return {
            "available": True,
            "mode": "grade_compare",
            "focused": True,
            "factor_labels": factor_labels,
            "compare_grades": normalized,
            "default_group": f"grade_{default_g}",
            "overall_avg": {k: round(v, 2) for k, v in overall_avg.items()},
            "groups": groups,
        }

    cohort_key = _normalize_sel_cohort(cohort)
    if cohort_key:
        grade_col = mapping.get("grade")
        grade_key = str(cohort_grade or "").strip().replace("Grade ", "") or None
        baseline_kind = (baseline or "").strip().lower()
        if baseline_kind not in ("grade", "school"):
            baseline_kind = "grade" if grade_key else "school"

        scope = sel_df
        if grade_key and grade_col and grade_col in df.columns:
            scope = sel_df[sel_df[grade_col].astype(str) == grade_key]
            if len(scope) == 0:
                return {"available": False, "reason": "no_sel_in_grade"}

        focal_df = scope[_sel_focus_mask(scope, cohort_key)]
        if len(focal_df) == 0:
            return {"available": False, "reason": "no_sel_focus_cohort"}

        if baseline_kind == "grade" and grade_key:
            baseline_avg = scope[sel_cols].mean().to_dict()
            overall_label = f"Grade {grade_key} average"
        else:
            baseline_avg = overall_avg
            overall_label = "School average"

        group_key = cohort_key if cohort_key != "triple_flag" else "triple_flag"
        return {
            "available": True,
            "mode": "focused",
            "focused": True,
            "factor_labels": factor_labels,
            "grade": grade_key,
            "focus_tier": cohort_key,
            "focus_label": _sel_focus_label(cohort_key, grade_key),
            "default_group": group_key,
            "overall_avg": {k: round(v, 2) for k, v in baseline_avg.items()},
            "overall_label": overall_label,
            "groups": {
                group_key: _sel_group_payload(focal_df, sel_cols, baseline_avg),
            },
        }

    groups = {
        "chronically_absent": sel_df[sel_df['chronic_absent']],
        "suspended":          sel_df[sel_df['has_suspension']],
        "failing_courses":    sel_df[sel_df['has_academic_failure']],
        "on_track":           sel_df[sel_df['flag_count'] == 0],
    }

    result = {
        "available":   True,
        "factor_labels": factor_labels,
        "overall_avg": {k: round(v, 2) for k, v in overall_avg.items()},
        "groups":      {},
    }

    for group_name, group_df in groups.items():
        if len(group_df) == 0:
            continue
        result["groups"][group_name] = _sel_group_payload(group_df, sel_cols, overall_avg)

    return result


ROW_LEVEL_MAX_RECORDS = 300


def _extract_student_id_from_message(message: str) -> Optional[str]:
    """Parse a student ID from a teacher message (e.g. 'student 1001')."""
    text = (message or "").strip()
    if not text:
        return None
    patterns = (
        r"student\s*(?:#|id)?\s*[:.]?\s*(\d+)",
        r"student\s+(\d+)",
        r"\bid\s*[:#]?\s*(\d+)",
    )
    for pat in patterns:
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def _find_student_record(records: list, sid_col: str, target: str) -> Optional[dict]:
    target_digits = re.sub(r"\D", "", target)
    for row in records:
        sid = str(row.get(sid_col, "")).strip()
        if sid == target or re.sub(r"\D", "", sid) == target_digits:
            return row
    return None


def run_row_level_analysis(
    df: pd.DataFrame,
    mapping: dict,
    thresholds: dict = None,
    message: str = '',
) -> dict:
    """
    Return the full dataset with risk flags calculated, for row-level queries.
    Claude receives all columns including SEL, demographics, raw counts.
    """
    df = calculate_risk_flags(df.copy(), mapping, thresholds)

    # Include every column — raw + computed flags
    records = _json_safe_records(df.fillna('').to_dict(orient='records'))

    # Normalize student IDs
    sid_col = mapping.get('student_id')
    if sid_col:
        for row in records:
            if sid_col in row:
                row[sid_col] = _normalize_student_id_display(row[sid_col])

    # Build column metadata for Claude context
    column_metadata = mapping.get('_column_metadata') or {}
    col_descriptions = {
        col: column_metadata.get(col, {}).get('label') or col
        for col in df.columns
    }
    sel_cols = mapping.get('sel_factors') or []
    factor_labels = {
        col: column_metadata.get(col, {}).get('label') or col
        for col in sel_cols
    }
    stripped_mapping = {k: v for k, v in mapping.items() if not k.startswith('_')}
    thresholds_used = {**DEFAULTS, **(thresholds or {})}

    target = _extract_student_id_from_message(message)
    if target and sid_col:
        record = _find_student_record(records, sid_col, target)
        if record:
            return {
                "available": True,
                "mode": "student_profile",
                "student_id": record.get(sid_col, target),
                "record": record,
                "col_descriptions": col_descriptions,
                "factor_labels": factor_labels,
                "mapping": stripped_mapping,
                "thresholds_used": thresholds_used,
            }

    truncated = len(records) > ROW_LEVEL_MAX_RECORDS
    return {
        "available": True,
        "mode": "cohort_sample",
        "total": len(records),
        "records": records[:ROW_LEVEL_MAX_RECORDS] if truncated else records,
        "truncated": truncated,
        "col_descriptions": col_descriptions,
        "factor_labels": factor_labels,
        "mapping": stripped_mapping,
        "thresholds_used": thresholds_used,
    }


# ---------------------------------------------------------------------------
# Student list
# ---------------------------------------------------------------------------

# Max rows returned to the UI in one request (full cohort counts stay in `total`).
STUDENT_LIST_DISPLAY_LIMIT = 500


def _mapping_col_for_demographic_role(mapping: dict, role: str) -> Optional[str]:
    """Resolve a mapping role to a dataframe column (ell and lep share either column)."""
    role = (role or "").strip().lower()
    if role in ("ell", "lep"):
        return mapping.get("ell") or mapping.get("lep")
    if role in ROSTER_DEMOGRAPHIC_ROLES:
        return mapping.get(role)
    return None


def _filter_demographic_subset(
    df: pd.DataFrame, mapping: dict, role: str
) -> tuple[pd.DataFrame, bool]:
    """Keep rows flagged yes on a mapped demographic role."""
    col = _mapping_col_for_demographic_role(mapping, role)
    if not col or col not in df.columns:
        return df, False
    return df[_demographic_yes_mask(df[col])].copy(), True


def _filter_ell_rows(df: pd.DataFrame, mapping: dict) -> tuple[pd.DataFrame, bool]:
    """Keep rows flagged as ELL/LEP when column is mapped."""
    return _filter_demographic_subset(df, mapping, "ell")


def _filter_min_course_failures(df: pd.DataFrame, mapping: dict, minimum: int) -> tuple[pd.DataFrame, bool]:
    """Filter by total courses failed (failtot column)."""
    col = mapping.get("failtot")
    if not col or col not in df.columns or minimum is None:
        return df, False
    counts = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return df[counts >= int(minimum)].copy(), True


def _filter_min_suspension_count(df: pd.DataFrame, mapping: dict, minimum: int) -> tuple[pd.DataFrame, bool]:
    """Filter by raw suspension/incident count column (e.g. 3+ suspensions)."""
    col = mapping.get("behavior")
    if not col or col not in df.columns or minimum is None:
        return df, False
    counts = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return df[counts >= int(minimum)].copy(), True


def resolve_custom_groups(message: str, mapping: dict, df: pd.DataFrame, prior_list_context: dict = None) -> list | None:
    """
    Interpret a teacher's natural language request and return N group filter specs.
    Returns None if the message is not a multi-group comparison request.
    """
    role_info: dict = {}
    for role, col in mapping.items():
        if role.startswith("_") or role in ("sel_factors", "text_columns"):
            continue
        if isinstance(col, list):
            for c in col:
                if c in df.columns:
                    unique = df[c].dropna().unique().tolist()[:5]
                    role_info[f"race_indicator:{c}"] = {"column": c, "sample_values": unique}
        elif col in df.columns:
            unique = df[col].dropna().unique().tolist()[:8]
            role_info[role] = {"column": col, "sample_values": unique}

    prior_context_block = ""
    if prior_list_context:
        tier = prior_list_context.get("tier")
        grade = prior_list_context.get("grade")
        filters = prior_list_context.get("filters_applied") or {}
        subset = filters.get("demographic_subset")
        parts = []
        if tier:
            parts.append(f"tier={tier}")
        if grade:
            parts.append(f"grade={grade}")
        if subset:
            parts.append(f"demographic_subset={subset}")
        if parts:
            prior_context_block = (
                f"\nPRIOR FILTER CONTEXT: The teacher is referring to a previously shown student list "
                f"filtered to: {', '.join(parts)}. "
                f"All groups should inherit these filters automatically. "
                f"Label groups by the demographic being asked about in the current question only — "
                f"not the full intersection. For example if prior context is ELL and teacher asks about SPED, "
                f"label groups 'SPED' and 'Non-SPED', not 'ELL+SPED' and 'ELL Only'.\n"
            )

    prompt = (
        f'A teacher asked: "{message}"\n\n'
        f"The student dataset has these mapped roles and actual column names/values:\n"
        f"{json.dumps(role_info, indent=2)}\n\n"
        "Is this a request to compare or break down by groups? If yes, return a JSON array "
        "of group filter specs — one per group the teacher named or implied.\n"
        "If no (e.g. it is a simple factual question or a request for a single analysis), return null.\n\n"
        "Rules:\n"
        "- Use ACTUAL column names from the mapping above, not role names.\n"
        "- Each group spec describes one subset of students.\n"
        "- There is no limit on the number of groups — return as many as the teacher described.\n"
        "- For demographic flags (race, gender, ELL etc.), column + value defines the group.\n"
        "- For risk tiers (triple-flag, on-track etc.), use the tier field.\n"
        "- For grade-specific groups, use the grade field.\n"
        "- For a school-wide baseline or average, use key='school_average', column=null, value=null.\n\n"
        "Core rule: if answering the question requires computing a metric for TWO OR MORE "
        "distinct subsets of students and comparing them, return those subsets as groups.\n"
        "Return null ONLY if the question has a single answer that needs no comparison.\n\n"
        "Pattern recognition:\n"
        "- 'which X has the most/highest/lowest Y' → groups = all values of X (e.g. all grades, all demographics)\n"
        "- 'compare X vs Y on Z' → groups = [X, Y]\n"
        "- 'how does X differ between A and B' → groups = [A, B]\n"
        "- 'break down X by Y' → groups = all values of Y\n"
        "- 'X among/within Z' → filter all groups to Z (e.g. tier=triple, grade=7)\n\n"
        "When comparing grades, include ALL grades present in the data (use grade field).\n"
        "When a demographic is mentioned (SPED, ELL, Hispanic, Low SES etc.), "
        "apply it as column+value filter on EVERY group — not just some groups.\n"
        "When a specific grade is mentioned, apply grade filter to EVERY group.\n"
        "Example: 'which subgroups have highest failure in Grade 7' → "
        "each group gets grade='7' AND its own column+value demographic filter.\n"
        "When filtering by risk tier, use the tier field (triple|two_or_more|on_track|high|moderate).\n"
        "Never drop any filter (grade, demographic, tier) just because another filter is present.\n\n"
        f"{prior_context_block}"
        "CRITICAL SCHEMA RULES:\n"
        "1. The ONLY valid fields in each group object are: key, label, column, value, tier, grade, exclude\n"
        "   and any role name from the mapping (e.g. low_ses, ell, special_ed) with integer value 0 or 1.\n"
        "2. NEVER invent fields like 'filter', 'condition', 'expression', 'attrate < 0.9', or any custom field.\n"
        "3. For risk-based groups (chronically absent, suspended, failing): use tier field ONLY.\n"
        "   chronically_absent → tier=two_or_more (NOT column+filter)\n"
        "   triple_flag → tier=triple\n"
        "   on_track → tier=on_track\n"
        "4. For demographic intersections (Low SES AND ELL), add role keys directly to the group object:\n"
        "   {'key': 'low_ses_ell', 'label': 'Low SES AND ELL', 'column': null, 'value': null,\n"
        "    'tier': 'triple', 'grade': '7', 'low_ses': 1, 'ell': 1}\n"
        "5. column+value is ONLY for race_indicator columns (binary 0/1 race flags).\n"
        "   For all other demographics (ell, low_ses, special_ed), use role keys directly.\n\n"
        "Return ONLY valid JSON — array of group objects or null:\n"
        "[\n"
        "  {\n"
        '    "key": "short_snake_case_identifier",\n'
        '    "label": "Human readable label for chart legend",\n'
        '    "column": "race_indicator_column_name or null",\n'
        '    "value": 1,\n'
        '    "tier": "triple | two_or_more | on_track | high | moderate | null",\n'
        '    "grade": "6 or 7 or null",\n'
        '    "low_ses": 1,\n'
        '    "ell": 1,\n'
        '    "special_ed": 1\n'
        "  }\n"
        "]"
    )

    try:
        resp = _claude.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=800,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text.strip()
        if text.lower().strip() == "null":
            return None
        start = text.find("[")
        end = text.rfind("]") + 1
        if start == -1 or end == 0:
            return None
        parsed = json.loads(text[start:end])
        if not isinstance(parsed, list) or len(parsed) == 0:
            return None
        return parsed
    except Exception as e:
        print(f"[resolve_custom_groups] failed: {e}")
        return None


def _apply_group_filter(df: pd.DataFrame, mapping: dict, g: dict) -> pd.DataFrame:
    result = df.copy()
    grade_col = mapping.get("grade")

    # column + value filter
    col = g.get("column")
    val = g.get("value")
    if col and col in result.columns and val is not None:
        if isinstance(val, int) or str(val) in ("0", "1"):
            result = result[pd.to_numeric(result[col], errors="coerce") == int(val)]
        else:
            result = result[
                result[col].astype(str).str.strip().str.lower() == str(val).lower()
            ]

    # tier filter
    tier = str(g.get("tier") or "").strip().lower()
    if tier == "triple":
        result = result[result["flag_count"] == 3]
    elif tier == "two_or_more":
        result = result[result["flag_count"] >= 2]
    elif tier == "on_track":
        result = result[result["flag_count"] == 0]
    elif tier == "high":
        result = result[result["flag_count"] == 2]
    elif tier == "moderate":
        result = result[result["flag_count"] == 1]

    # grade filter
    grade = str(g.get("grade") or "").strip().replace("Grade ", "")
    if grade and grade_col and grade_col in result.columns:
        result = result[
            result[grade_col].astype(str).str.strip()
            .str.replace(r"\.0$", "", regex=True) == grade
        ]

    # Dynamic demographic field filters — any key in the group spec that maps
    # to a scalar column in the mapping and has an integer value (0 or 1)
    SKIP_KEYS = {"key", "label", "column", "value", "tier", "grade", "exclude"}
    LIST_ROLES = {"sel_factors", "text_columns", "race_indicators"}
    role_to_col = {
        role: col for role, col in mapping.items()
        if role not in SKIP_KEYS
        and role not in LIST_ROLES
        and not role.startswith("_")
        and isinstance(col, str)
    }
    # ell and lep resolve to whichever is mapped
    ell_col = mapping.get("ell") or mapping.get("lep")
    if ell_col:
        role_to_col["ell"] = ell_col
        role_to_col["lep"] = ell_col

    for field, field_val in g.items():
        if field in SKIP_KEYS or field_val is None:
            continue
        mapped_col = role_to_col.get(field)
        if not mapped_col or mapped_col not in result.columns:
            continue
        try:
            result = result[
                pd.to_numeric(result[mapped_col], errors="coerce").fillna(-1) == int(field_val)
            ]
        except (TypeError, ValueError):
            continue

    for field, field_val in g.get("exclude", {}).items():
        mapped_col = role_to_col.get(field)
        if not mapped_col or mapped_col not in result.columns:
            continue
        try:
            result = result[
                pd.to_numeric(result[mapped_col], errors="coerce").fillna(-1) != int(field_val)
            ]
        except (TypeError, ValueError):
            continue

    return result


def run_group_comparison(
    df: pd.DataFrame,
    mapping: dict,
    groups: list,
    metric: str,
    thresholds: dict = None,
) -> dict:
    """
    For each group filter spec, apply the filter and compute the requested metric.
    Returns a unified payload the frontend can render as a chart or table.

    metric options:
      "sel"        — SEL factor averages vs school average
      "absence"    — chronic absence rate
      "failure"    — course failure rate
      "suspension" — suspension rate
      "flags"      — flag count distribution (0, 1, 2, 3 flags)
    """
    df = calculate_risk_flags(df.copy(), mapping, thresholds)
    total = len(df)

    baselines: dict = {
        "sel": None,
        "absence": round(df["chronic_absent"].mean() * 100, 1) if total else 0,
        "failure": round(df["has_academic_failure"].mean() * 100, 1) if total else 0,
        "suspension": round(df["has_suspension"].mean() * 100, 1) if total else 0,
        "indicators": {
            "absence": round(df["chronic_absent"].mean() * 100, 1) if total else 0,
            "suspension": round(df["has_suspension"].mean() * 100, 1) if total else 0,
            "failure": round(df["has_academic_failure"].mean() * 100, 1) if total else 0,
        },
        "flags": {
            "0": round((df["flag_count"] == 0).mean() * 100, 1),
            "1": round((df["flag_count"] == 1).mean() * 100, 1),
            "2": round((df["flag_count"] == 2).mean() * 100, 1),
            "3": round((df["flag_count"] == 3).mean() * 100, 1),
        },
    }

    sel_cols: list = []
    overall_sel_avg: dict = {}
    if metric == "sel" and "sel_factors" in mapping:
        sel_cols = [c for c in mapping["sel_factors"] if c in df.columns]
        if sel_cols:
            sel_df = df.dropna(subset=sel_cols, how="all")
            overall_sel_avg = sel_df[sel_cols].mean().to_dict()
            baselines["sel"] = overall_sel_avg

    result_groups: dict = {}
    for g in groups:
        key = g.get("key", f"group_{len(result_groups)}")
        label = g.get("label", key)

        is_school_avg = key == "school_average" or (
            not g.get("column") and not g.get("tier") and not g.get("grade")
        )
        group_df = df if is_school_avg else _apply_group_filter(df, mapping, g)
        print(f"[group_comparison] group={key!r} n={len(group_df)} total={len(df)} spec={g}")  # TODO: remove

        n = len(group_df)
        if n == 0:
            continue

        if metric == "sel":
            if not sel_cols:
                continue
            group_sel = group_df.dropna(subset=sel_cols, how="all")
            if len(group_sel) == 0:
                continue
            payload = _sel_group_payload(group_sel, sel_cols, overall_sel_avg)
            payload["label"] = label
            payload["n"] = n

        elif metric == "absence":
            severe = int(group_df["severe_absent"].sum()) if "severe_absent" in group_df.columns else 0
            payload = {
                "label": label,
                "n": n,
                "value": round(group_df["chronic_absent"].mean() * 100, 1),
                "severe_value": round(severe / n * 100, 1),
                "count": int(group_df["chronic_absent"].sum()),
                "metric_label": "Chronic absence rate",
            }

        elif metric == "failure":
            payload = {
                "label": label,
                "n": n,
                "value": round(group_df["has_academic_failure"].mean() * 100, 1),
                "count": int(group_df["has_academic_failure"].sum()),
                "metric_label": "Course failure rate",
            }
            failtot_col = mapping.get("failtot")
            if failtot_col and failtot_col in group_df.columns:
                payload["avg_courses_failed"] = round(
                    pd.to_numeric(group_df[failtot_col], errors="coerce").mean(), 1
                )

        elif metric == "suspension":
            payload = {
                "label": label,
                "n": n,
                "value": round(group_df["has_suspension"].mean() * 100, 1),
                "count": int(group_df["has_suspension"].sum()),
                "metric_label": "Suspension rate",
            }

        elif metric == "flags":
            payload = {
                "label": label,
                "n": n,
                "metric_label": "Flag distribution",
                "values": {
                    "0": round((group_df["flag_count"] == 0).mean() * 100, 1),
                    "1": round((group_df["flag_count"] == 1).mean() * 100, 1),
                    "2": round((group_df["flag_count"] == 2).mean() * 100, 1),
                    "3": round((group_df["flag_count"] == 3).mean() * 100, 1),
                },
            }

        elif metric == "indicators":
            # Check if binary rates are meaningful — if all groups share the same tier,
            # binary flag rates will be identical and useless; use raw depth metrics instead
            group_tiers = set(
                str(g.get("tier", "")).lower()
                for g in groups
                if g.get("tier")
            )
            use_depth = len(group_tiers) == 1

            # Build depth metrics from any numeric columns in the mapping
            # that are not binary flags and not the grade column
            SKIP_ROLES = {"student_id", "grade", "attendance", "days_absent",
                          "sel_factors", "text_columns", "race_indicators"}
            depth_cols = {}
            for role, col in mapping.items():
                if role in SKIP_ROLES or role.startswith("_") or not isinstance(col, str):
                    continue
                if col not in group_df.columns:
                    continue
                numeric = pd.to_numeric(group_df[col], errors="coerce")
                if numeric.isna().all():
                    continue
                # Only include columns with meaningful range (not binary 0/1 flags)
                if numeric.max() - numeric.min() > 1:
                    depth_cols[role] = col

            if use_depth and depth_cols:
                payload = {
                    "label": label,
                    "n": n,
                    "metric_label": "Risk depth",
                    "absence": round(group_df["chronic_absent"].mean() * 100, 1),
                    "suspension": round(group_df["has_suspension"].mean() * 100, 1),
                    "failure": round(group_df["has_academic_failure"].mean() * 100, 1),
                }
                for role, col in depth_cols.items():
                    payload[f"avg_{role}"] = round(
                        pd.to_numeric(group_df[col], errors="coerce").mean(), 1
                    )
                if "days_missed_pct" in group_df.columns:
                    payload["avg_days_missed_pct"] = round(group_df["days_missed_pct"].mean(), 1)
            else:
                payload = {
                    "label": label,
                    "n": n,
                    "metric_label": "Risk indicators",
                    "absence": round(group_df["chronic_absent"].mean() * 100, 1),
                    "suspension": round(group_df["has_suspension"].mean() * 100, 1),
                    "failure": round(group_df["has_academic_failure"].mean() * 100, 1),
                    "absence_count": int(group_df["chronic_absent"].sum()),
                    "suspension_count": int(group_df["has_suspension"].sum()),
                    "failure_count": int(group_df["has_academic_failure"].sum()),
                }
                for role, col in depth_cols.items():
                    payload[f"avg_{role}"] = round(
                        pd.to_numeric(group_df[col], errors="coerce").mean(), 1
                    )

        else:
            continue

        result_groups[key] = payload

    if not result_groups:
        return {"available": False, "reason": "no_data_for_any_group"}

    if metric == "sel":  # TODO: remove
        print(f"[run_group_comparison] SEL payload sample: {json.dumps({k: v.get('averages') for k, v in result_groups.items()}, indent=2)}")

    out: dict = {
        "available": True,
        "mode": "custom_group_compare",
        "metric": metric,
        "groups": result_groups,
        "baseline": baselines.get(metric),
        "baseline_label": "School average",
        "total_students": total,
    }
    # SELAnalysis reads data.overall_avg — expose school-wide SEL averages under that key.
    if metric == "sel" and overall_sel_avg:
        out["overall_avg"] = {k: round(v, 2) for k, v in overall_sel_avg.items()}
    return out


def resolve_dynamic_filters(message: str, mapping: dict, df: pd.DataFrame) -> dict:
    role_info: dict = {}
    for role, col in mapping.items():
        if role.startswith("_") or role in ("sel_factors", "text_columns"):
            continue
        if isinstance(col, list):
            for c in col:
                if c in df.columns:
                    unique = df[c].dropna().unique().tolist()[:5]
                    role_info[f"race_indicator:{c}"] = {"column": c, "sample_values": unique}
        elif col in df.columns:
            unique = df[col].dropna().unique().tolist()[:8]
            role_info[role] = {"column": col, "sample_values": unique}

    prompt = (
        f'A teacher asked: "{message}"\n\n'
        f"The student dataset has these mapped roles and their actual column names and values:\n"
        f"{json.dumps(role_info, indent=2)}\n\n"
        "Return a JSON filter spec that captures every condition the teacher mentioned.\n\n"
        "Rules:\n"
        "- Use ACTUAL column names from the mapping above, not role names.\n"
        "- demographic_filters: list of role names (from the mapping keys) that should be filtered to their positive value (1/yes). Include ALL demographics mentioned — overage, ell, lep, special_ed, low_ses, gender etc.\n"
        "- column_filters: list of {column, value} for any additional column-level filters not covered by demographic_filters (e.g. specific race column values).\n"
        "- tier: only set when the teacher explicitly names a risk tier.\n"
        "- grade: only set when scoping TO a single grade, not comparing across grades.\n"
        "- min_numeric: list of {role, minimum} for any 'at least N' numeric conditions on mapped roles.\n"
        "- sort_by: role name to sort by descending.\n\n"
        "Return ONLY valid JSON:\n"
        "{\n"
        '  "grade": "7" | null,\n'
        '  "tier": "triple" | "two_or_more" | "all" | "high" | "moderate" | null,\n'
        '  "demographic_filters": ["ell", "special_ed", "overage"] | [],\n'
        '  "column_filters": [{"column": "col_name", "value": 1}] | [],\n'
        '  "min_numeric": [{"role": "failtot", "minimum": 3}] | [],\n'
        '  "sort_by": "failtot" | null\n'
        "}"
    )

    try:
        resp = _claude.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=400,
            messages=[{"role": "user", "content": prompt}],
        )
        text = resp.content[0].text.strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        return json.loads(text[start:end])
    except Exception as e:
        print(f"[resolve_dynamic_filters] failed: {e}")
        return {}


def apply_dynamic_filters(df: pd.DataFrame, mapping: dict, filters: dict) -> pd.DataFrame:
    if not filters:
        return df

    df = calculate_risk_flags(df.copy(), mapping)

    # Grade
    grade = str(filters.get("grade") or "").strip().replace("Grade ", "")
    grade_col = mapping.get("grade")
    if grade and grade_col and grade_col in df.columns:
        df = df[
            df[grade_col].astype(str).str.strip()
            .str.replace(r"\.0$", "", regex=True) == grade
        ].copy()

    # Tier
    tier = str(filters.get("tier") or "").strip().lower()
    if tier == "triple":
        df = df[df["flag_count"] == 3].copy()
    elif tier == "two_or_more":
        df = df[df["flag_count"] >= 2].copy()
    elif tier in ("critical", "high", "moderate"):
        min_flags = {"critical": 3, "high": 2, "moderate": 1}
        df = df[df["flag_count"] >= min_flags[tier]].copy()

    # Demographic filters — generic loop over any role that maps to a scalar column
    LIST_ROLES = {"sel_factors", "text_columns", "race_indicators"}
    role_to_col = {
        role: col for role, col in mapping.items()
        if not role.startswith("_")
        and role not in LIST_ROLES
        and isinstance(col, str)
        and col in df.columns
    }
    # ell and lep resolve to whichever is mapped
    ell_col = mapping.get("ell") or mapping.get("lep")
    if ell_col:
        role_to_col["ell"] = ell_col
        role_to_col["lep"] = ell_col

    for role in filters.get("demographic_filters") or []:
        col = role_to_col.get(str(role).strip().lower())
        if not col or col not in df.columns:
            continue
        df, _ = _filter_demographic_subset(df, mapping, role)

    # Column-level filters
    for cf in filters.get("column_filters") or []:
        col = cf.get("column")
        val = cf.get("value")
        if not col or col not in df.columns or val is None:
            continue
        if isinstance(val, int) or str(val) in ("0", "1"):
            df = df[pd.to_numeric(df[col], errors="coerce") == int(val)].copy()
        else:
            df = df[df[col].astype(str).str.strip().str.lower() == str(val).lower()].copy()

    # Min numeric filters — any role with a minimum threshold
    for mn in filters.get("min_numeric") or []:
        role = str(mn.get("role") or "").strip().lower()
        minimum = mn.get("minimum")
        col = role_to_col.get(role)
        if not col or col not in df.columns or minimum is None:
            continue
        df = df[pd.to_numeric(df[col], errors="coerce").fillna(0) >= float(minimum)].copy()

    # Sort
    sort_role = str(filters.get("sort_by") or "").strip().lower()
    if sort_role:
        sort_col = role_to_col.get(sort_role)
        if sort_col and sort_col in df.columns:
            df = df.sort_values(sort_col, ascending=False, na_position="last")

    return df


def run_students_analysis(
    df: pd.DataFrame,
    mapping: dict,
    tier: str = "critical",
    thresholds: dict = None,
    grade_filter: Optional[str] = None,
    dynamic_filters: Optional[dict] = None,
    require_ell: bool = False,
    demographic_subset: Optional[str] = None,
    demographic_sort_roles: Optional[list] = None,
    min_suspension_count: Optional[int] = None,
    min_course_failures: Optional[int] = None,
    sort_by: Optional[str] = None,
) -> dict:
    """Student list stage - filter by tier, sort by severity, return rows + summary."""
    df = calculate_risk_flags(df, mapping, thresholds)
    # Keep tier buckets only for student-list filtering UX.
    df['risk_tier'] = 'on_track'
    df.loc[df['flag_count'] == 1, 'risk_tier'] = 'moderate'
    df.loc[df['flag_count'] == 2, 'risk_tier'] = 'high'
    # Critical = all three indicators (same as overlap.all_three / tier triple)
    df.loc[df['flag_count'] == 3, 'risk_tier'] = 'critical'

    if tier in ("triple", "critical"):
        filtered = df[df["flag_count"] == 3].copy()
    elif tier in ("two_or_more", "overlap", "multi_flag"):
        filtered = df[df["flag_count"] >= 2].copy()
    elif tier == "academic_only":
        filtered = df[df["has_academic_failure"] & (~df["chronic_absent"]) & (~df["has_suspension"])].copy()
    elif tier == "absent_academic":
        filtered = df[df["chronic_absent"] & df["has_academic_failure"] & (~df["has_suspension"])].copy()
    elif tier in ("all", "full"):
        filtered = df.copy()
    elif tier == "high":
        filtered = df[df["risk_tier"].isin(["critical", "high"])].copy()
    elif tier == "moderate":
        filtered = df[df["risk_tier"] == "moderate"].copy()
    elif tier == "on_track":
        filtered = df[df["risk_tier"] == "on_track"].copy()
    else:
        filtered = df[df["risk_tier"] != "on_track"].copy()

    grade_col_data = mapping.get("grade")
    if grade_filter and grade_col_data and grade_col_data in filtered.columns:
        grade_key = str(grade_filter).strip().replace("Grade ", "")
        grade_series = pd.to_numeric(filtered[grade_col_data], errors="coerce")
        grade_mask = grade_series.notna() & (grade_series.astype(int).astype(str) == grade_key)
        if not int(grade_mask.sum()):
            grade_mask = filtered[grade_col_data].astype(str).str.strip().str.replace(r"\.0$", "", regex=True) == grade_key
        filtered = filtered[grade_mask].copy()

    filters_applied: dict = {"tier": tier, "grade": grade_filter}

    # Apply dynamic filters (from resolve_dynamic_filters) before the standard filter params.
    if dynamic_filters:
        f = dynamic_filters

        # Grade override (if not already applied above)
        if not grade_filter and f.get("grade"):
            dyn_grade = str(f["grade"]).strip().replace("Grade ", "")
            grade_col_data = mapping.get("grade")
            if grade_col_data and grade_col_data in filtered.columns:
                grade_series = pd.to_numeric(filtered[grade_col_data], errors="coerce")
                grade_mask = grade_series.notna() & (grade_series.astype(int).astype(str) == dyn_grade)
                if not int(grade_mask.sum()):
                    grade_mask = (
                        filtered[grade_col_data].astype(str).str.strip()
                        .str.replace(r"\.0$", "", regex=True) == dyn_grade
                    )
                filtered = filtered[grade_mask].copy()
                filters_applied["grade"] = dyn_grade

        # Gender
        gender_val = (f.get("gender") or "").strip().lower()
        gender_col = mapping.get("gender")
        if gender_val and gender_col and gender_col in filtered.columns:
            unique_vals = filtered[gender_col].dropna().unique()
            sample = str(unique_vals[0]).strip().lower() if len(unique_vals) else ""
            if sample in ("0", "1"):
                match_val = 0 if gender_val == "male" else 1
                filtered = filtered[pd.to_numeric(filtered[gender_col], errors="coerce") == match_val].copy()
            elif sample in ("m", "f"):
                match_val = "m" if gender_val == "male" else "f"
                filtered = filtered[filtered[gender_col].str.strip().str.lower() == match_val].copy()
            else:
                filtered = filtered[filtered[gender_col].str.strip().str.lower() == gender_val].copy()
            filters_applied["gender"] = gender_val

        # Race
        race_col = f.get("race_column")
        race_val = f.get("race_value")
        if race_col and race_col in filtered.columns and race_val is not None:
            if isinstance(race_val, int) or str(race_val) in ("0", "1"):
                filtered = filtered[
                    pd.to_numeric(filtered[race_col], errors="coerce") == int(race_val)
                ].copy()
            else:
                filtered = filtered[
                    filtered[race_col].astype(str).str.strip().str.lower() == str(race_val).lower()
                ].copy()
            filters_applied["race_column"] = race_col
            filters_applied["race_value"] = race_val

        # Let dynamic values override the explicit params if set
        if f.get("min_course_failures") is not None:
            min_course_failures = f["min_course_failures"]
        if f.get("min_suspension_count") is not None:
            min_suspension_count = f["min_suspension_count"]
        if f.get("sort_by"):
            sort_by = f["sort_by"]
        if f.get("demographic_subset"):
            demographic_subset = f["demographic_subset"]

    subset_role = (demographic_subset or "").strip().lower() or None
    if require_ell and not subset_role:
        subset_role = "ell"
    if subset_role:
        if subset_role == "lep":
            subset_role = "ell"
        if subset_role in ROSTER_DEMOGRAPHIC_ROLES or subset_role == "ell":
            filtered, subset_ok = _filter_demographic_subset(filtered, mapping, subset_role)
            filters_applied["demographic_subset"] = subset_role
            filters_applied["demographic_subset_column"] = _mapping_col_for_demographic_role(
                mapping, subset_role
            )
            filters_applied["demographic_subset_applied"] = subset_ok
    sort_roles: list = []
    if demographic_sort_roles:
        for raw in demographic_sort_roles:
            r = str(raw).strip().lower()
            if r == "lep":
                r = "ell"
            if r in ROSTER_DEMOGRAPHIC_ROLES and r not in sort_roles:
                sort_roles.append(r)
    if sort_roles:
        filters_applied["demographic_sort_roles"] = sort_roles
    if min_suspension_count is not None:
        filtered, susp_ok = _filter_min_suspension_count(filtered, mapping, min_suspension_count)
        filters_applied["min_suspension_count"] = int(min_suspension_count)
        filters_applied["behavior_column"] = mapping.get("behavior")
        filters_applied["suspension_count_applied"] = susp_ok
    if min_course_failures is not None:
        filtered, fail_ok = _filter_min_course_failures(filtered, mapping, min_course_failures)
        filters_applied["min_course_failures"] = int(min_course_failures)
        filters_applied["failtot_column"] = mapping.get("failtot")
        filters_applied["course_failures_applied"] = fail_ok

    sort_key = (sort_by or "").strip().lower()
    failtot_col = mapping.get("failtot")
    if not sort_key and tier == "academic_only" and failtot_col and failtot_col in filtered.columns:
        sort_key = "courses_failed"
    if sort_key in ("courses_failed", "failtot", "total_courses_failed") and failtot_col and failtot_col in filtered.columns:
        filtered = filtered.sort_values(
            failtot_col,
            ascending=False,
            na_position="last",
        )
        filters_applied["sort_by"] = "courses_failed"
    elif "days_missed_pct" in filtered.columns:
        filtered = filtered.sort_values("days_missed_pct", ascending=False)
        if sort_key:
            filters_applied["sort_by"] = sort_key

    by_grade: dict = {}
    if grade_col_data and grade_col_data in filtered.columns:
        for grade, grp in filtered.groupby(
            pd.to_numeric(filtered[grade_col_data], errors="coerce").fillna(-1).astype(int)
        ):
            if int(grade) >= 0:
                by_grade[str(int(grade))] = int(len(grp))

    severe_count = int(filtered["severe_absent"].sum()) if "severe_absent" in filtered.columns else 0
    chronic_count = int(filtered["chronic_absent"].sum()) if "chronic_absent" in filtered.columns else 0
    n_matched = len(filtered)

    cols_to_show = [
        'days_missed_pct', 'chronic_absent', 'severe_absent',
        'has_suspension', 'has_academic_failure', 'risk_tier', 'flag_count',
    ]
    for role, col in mapping.items():
        if isinstance(col, (list, tuple, set, dict)):
            continue
        if not isinstance(col, str):
            continue
        if col in filtered.columns:
            cols_to_show.append(col)

    available_cols = [c for c in cols_to_show if c in filtered.columns]
    students = filtered[available_cols].head(STUDENT_LIST_DISPLAY_LIMIT).to_dict(orient='records')
    students = _json_safe_records(students)

    student_id_col = mapping.get("student_id")
    if student_id_col and students:
        for row in students:
            if student_id_col in row:
                row[student_id_col] = _normalize_student_id_display(row[student_id_col])

    min_fail = filters_applied.get("min_course_failures")
    if min_fail:
        filters_applied["list_title"] = f"Tutoring priority — {min_fail}+ course failures"

    return {
        "students":            students,
        "total":               n_matched,
        "shown":               len(students),
        "truncated":           n_matched > len(students),
        "by_grade":            by_grade,
        "chronic_absent_count": chronic_count,
        "severe_absent_count": severe_count,
        "tier_filter":         tier,
        "filters_applied":     filters_applied,
        "list_title":          filters_applied.get("list_title"),
    }


# ---------------------------------------------------------------------------
# Text column analysis
# ---------------------------------------------------------------------------

def analyze_text_column(df: pd.DataFrame, column: str) -> dict:
    """Basic analysis of a text/categorical column."""
    col     = df[column].dropna().astype(str)
    missing = int(df[column].isna().sum())
    if len(col) == 0:
        return {
            "column":           column,
            "total_responses":  0,
            "unique_values":    0,
            "top_values":       {},
            "missing":          missing,
            "is_categorical":   True,
            "sample_responses": None,
        }
    value_counts = col.value_counts()
    return {
        "column":           column,
        "total_responses":  len(col),
        "unique_values":    int(col.nunique()),
        "top_values":       value_counts.head(10).to_dict(),
        "missing":          missing,
        "is_categorical":   col.nunique() <= 20,
        "sample_responses": col.sample(min(5, len(col)), random_state=42).tolist()
                            if col.nunique() > 20 else None,
    }


def detect_text_columns(df: pd.DataFrame, mapping: dict) -> list:
    """
    Find columns containing real free-text that are not already mapped.
    Excludes short codes (Y/N, 0/1, M/F) by requiring at least one value longer than 3 chars.
    """
    already_mapped: set = set()
    for k, v in mapping.items():
        if k in ('sel_factors', 'text_columns', 'race_indicators') and isinstance(v, list):
            already_mapped.update(v)
        elif v is not None and not isinstance(v, list):
            already_mapped.add(v)

    text_cols = []
    for col in df.columns:
        if col in already_mapped:
            continue
        if df[col].dtype == object or getattr(df[col].dtype, "name", "") == "string":
            non_null = df[col].dropna().astype(str).str.strip()
            if non_null.str.len().gt(3).any():
                text_cols.append(col)
    return text_cols