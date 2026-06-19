from fastapi import APIRouter, UploadFile, File, HTTPException, Query
from pydantic import BaseModel, field_validator
from typing import Optional
import pandas as pd
import io
import json
import hashlib
import tempfile
from pathlib import Path

from pypdf import PdfReader
from docx import Document as DocxDocument

from services.analysis_service import (
    map_variables,
    map_roles_from_confirmed_names,
    run_individual_risk,
    run_intersection_analysis,
    run_subgroup_analysis,
    run_triple_flag_cohort_subgroup,
    run_grade_subgroup_driver_analysis,
    run_unified_analysis,
    run_sel_analysis,
    run_students_analysis,
    resolve_dynamic_filters,
    apply_dynamic_filters,
    resolve_custom_groups,
    run_group_comparison,
    run_row_level_analysis,
    analyze_text_column,
    detect_text_columns,
)

import math

def _sanitize_json(obj):
    """Recursively replace NaN/Inf/−Inf with None so FastAPI can serialize."""
    if isinstance(obj, dict):
        return {k: _sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_json(v) for v in obj]
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    return obj

router = APIRouter()

# In-memory file cache with disk persistence
_file_cache: dict = {}
_cache_dir = Path(tempfile.gettempdir()) / "edvise_analysis_cache"
_cache_dir.mkdir(parents=True, exist_ok=True)


def _cache_path_for_file_id(file_id: str) -> Path:
    digest = hashlib.sha256(file_id.encode("utf-8")).hexdigest()
    return _cache_dir / f"{digest}.pkl"


def _persist_file_cache(file_id: str, df: pd.DataFrame) -> None:
    try:
        df.to_pickle(_cache_path_for_file_id(file_id))
    except Exception:
        pass


def _load_cached_file(file_id: str) -> Optional[pd.DataFrame]:
    p = _cache_path_for_file_id(file_id)
    if not p.exists():
        return None
    try:
        df = pd.read_pickle(p)
        _file_cache[file_id] = df
        return df
    except Exception:
        return None


class AnalysisRequest(BaseModel):
    file_id: str
    mapping: dict
    thresholds: Optional[dict] = None
    stage: str  # "individual" | "intersection" | "unified" | "subgroup" | "triple_flag_subgroup" | "sel" | "students"
    message: Optional[str] = None
    filter_tier: Optional[str] = "critical"
    grade_filter: Optional[str] = None
    require_ell: Optional[bool] = None
    demographic_subset: Optional[str] = None
    demographic_sort_roles: Optional[list] = None
    min_suspension_count: Optional[int] = None
    sort_by: Optional[str] = None
    min_course_failures: Optional[int] = None
    sel_cohort: Optional[str] = None
    sel_cohort_grade: Optional[str] = None
    sel_baseline: Optional[str] = None
    sel_compare_grades: Optional[list] = None
    sel_compare_dimension: Optional[str] = None
    sel_compare_grade: Optional[str] = None
    custom_groups: Optional[list] = None
    comparison_metric: Optional[str] = None  # "sel" | "absence" | "failure" | "suspension" | "flags"
    prior_list_context: Optional[dict] = None

    @field_validator("stage", mode="before")
    @classmethod
    def normalize_stage(cls, v):
        """Strip/case-fold so routing never misses due to whitespace or casing."""
        if v is None:
            return ""
        s = str(v).strip().lower()
        aliases = {
            "sub_group": "subgroup",
            "subgroups": "subgroup",
            "sub-group": "subgroup",
        }
        return aliases.get(s, s)


@router.get("/preview")
async def preview_file(file_id: str, rows: int = 50):
    df = _file_cache.get(file_id)
    if df is None:
        df = _load_cached_file(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File session expired.")
    preview = df.head(rows).fillna('').astype(str)
    return {
        "columns": list(preview.columns),
        "rows": preview.to_dict(orient='records'),
    }


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload and preview a student data file (CSV, Excel, PDF, or DOCX)."""
    content = await file.read()
    filename = (file.filename or "upload").lower()
    df = None

    if filename.endswith(".csv"):
        df = pd.read_csv(io.BytesIO(content))

    elif filename.endswith((".xlsx", ".xls")):
        df = pd.read_excel(io.BytesIO(content))

    elif filename.endswith(".pdf"):
        reader = PdfReader(io.BytesIO(content))
        text = ""
        for page in reader.pages:
            text += page.extract_text() + "\n"
        try:
            df = pd.read_csv(io.StringIO(text))
        except Exception:
            raise HTTPException(
                status_code=400,
                detail="Could not extract tabular data from PDF. Please export your data as CSV or Excel instead.",
            )

    elif filename.endswith(".docx"):
        doc = DocxDocument(io.BytesIO(content))
        tables = doc.tables
        if not tables:
            raise HTTPException(
                status_code=400,
                detail="No tables found in DOCX file. Please export your data as CSV or Excel instead.",
            )
        table = tables[0]
        headers = [cell.text.strip() for cell in table.rows[0].cells]
        rows = []
        for row in table.rows[1:]:
            rows.append([cell.text.strip() for cell in row.cells])
        df = pd.DataFrame(rows, columns=headers)
        for col in df.columns:
            try:
                df[col] = pd.to_numeric(df[col])
            except (ValueError, TypeError):
                pass

    else:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Please upload CSV, Excel, PDF, or DOCX.",
        )

    if df is None or len(df) == 0:
        raise HTTPException(status_code=400, detail="File appears to be empty or could not be parsed.")

    content_hash = hashlib.md5(content).hexdigest()[:8]
    file_id = f"file_{content_hash}_{filename}"
    _file_cache[file_id] = df
    _persist_file_cache(file_id, df)

    # map_variables returns the role-keyed mapping PLUS two internal keys:
    #   '_column_metadata' - per-column {role, label, description, confidence} from Claude
    #   'text_columns'     - list of open-ended text columns
    raw_mapping = map_variables(df)

    # Extract the two internal keys before sending mapping to the frontend
    column_metadata = raw_mapping.pop('_column_metadata', {})
    text_columns_from_mapping = raw_mapping.pop('text_columns', [])

    # Also run detect_text_columns as a secondary pass for anything Claude missed
    detected_text = detect_text_columns(df, raw_mapping)

    # Merge both sources, preserve order, deduplicate
    all_text_columns = list(dict.fromkeys(text_columns_from_mapping + detected_text))

    return {
        "file_id":          file_id,
        "filename":         file.filename,
        "rows":             len(df),
        "columns":          list(df.columns),
        # suggested_mapping: role-keyed dict (attendance, behavior, math, sel_factors, etc.)
        # used as the starting state for the DataConfirmCard dropdowns
        "suggested_mapping": raw_mapping,
        # column_metadata: per-column labels + descriptions from Claude
        # used by DataConfirmCard to show human-readable labels next to each dropdown
        # shape: { "col_name": { role, label, description, confidence }, ... }
        "column_metadata":  column_metadata,
        # text_columns: list of column names identified as open-ended text responses
        "text_columns":     all_text_columns,
        "preview":          df.head(3).fillna("").to_dict(orient="records"),
    }


class ConfirmNamesRequest(BaseModel):
    file_id: str
    confirmed_names: dict  # { original_col: confirmed_name } — only toggled-ON columns


@router.post("/confirm-names")
async def confirm_variable_names(req: ConfirmNamesRequest):
    """
    Called after teacher confirms/edits suggested column names in DataConfirmCard.
    Maps confirmed names to roles and returns standard mapping + column_metadata.
    """
    df = _file_cache.get(req.file_id)
    if df is None:
        df = _load_cached_file(req.file_id)
    if df is None:
        raise HTTPException(
            status_code=404,
            detail="File session expired. Please upload your data file again.",
        )

    raw_mapping = map_roles_from_confirmed_names(req.confirmed_names, df)
    column_metadata = raw_mapping.pop('_column_metadata', {})

    return {
        "suggested_mapping": raw_mapping,
        "column_metadata": column_metadata,
    }


@router.post("/text")
async def analyze_text(file_id: str = Query(...), column: str = Query(...)):
    """Analyze a single text/categorical column from an uploaded file."""
    df = _file_cache.get(file_id)
    if df is None:
        df = _load_cached_file(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File session expired. Please upload again.")
    if column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{column}' not found in dataset.")
    return analyze_text_column(df, column)


@router.post("/run")
async def run_analysis(req: AnalysisRequest):
    """
    Run a specific analysis stage on an uploaded file.

    The mapping passed in req.mapping comes from the DataConfirmCard after the
    teacher has reviewed/corrected Claude's suggestions. It uses the same
    role-keyed structure as suggested_mapping:
      {
        "attendance": "attrate",
        "behavior": "suspensions",
        "math": "failmth",
        "english": "faileng",
        "grade": "grade",
        "gender": "female",
        "race_indicators": ["white", "black", "asian", "hispanic", "other"],
        "low_ses": "ses",
        "special_ed": "speced",
        "lep": "lep",
        "sel_factors": ["equity", "future", "acdeng", "connect", "support", "acdpress", "caring"],
        ...
      }
    """
    df = _file_cache.get(req.file_id)
    if df is None:
        df = _load_cached_file(req.file_id)
    if df is None:
        print(f"[analysis/run] file not found: file_id={req.file_id!r} stage={req.stage!r}")
        raise HTTPException(
            status_code=404,
            detail="File session expired. Please upload your data file again.",
        )

    # Pre-filter df using the teacher's natural-language message before routing to any
    # analysis function.  Skipped for stages that always need the full school view.
    FULL_SCHOOL_STAGES = {"unified", "individual", "intersection", "row_level", "group_comparison", "students"}
    if req.message and req.stage not in FULL_SCHOOL_STAGES:
        dynamic_filters = resolve_dynamic_filters(req.message, req.mapping, df)
        if dynamic_filters:
            df = apply_dynamic_filters(df, req.mapping, dynamic_filters)

    if req.stage == "individual":
        result = run_individual_risk(df, req.mapping, req.thresholds)
    elif req.stage == "intersection":
        result = run_intersection_analysis(df, req.mapping, req.thresholds)
    elif req.stage == "unified":
        result = run_unified_analysis(df, req.mapping, req.thresholds)
    elif req.stage == "subgroup":
        column_metadata = req.mapping.get('_column_metadata') or {}
        result = run_subgroup_analysis(df, req.mapping, req.thresholds, column_metadata)
    elif req.stage == "triple_flag_subgroup":
        column_metadata = req.mapping.get('_column_metadata') or {}
        result = run_triple_flag_cohort_subgroup(df, req.mapping, req.thresholds, column_metadata)
    elif req.stage == "grade_subgroup":
        column_metadata = req.mapping.get('_column_metadata') or {}
        result = run_grade_subgroup_driver_analysis(
            df, req.mapping, req.thresholds, req.grade_filter, column_metadata
        )
    elif req.stage == "sel":
        custom_groups = req.custom_groups
        if not custom_groups and req.message:
            custom_groups = resolve_custom_groups(req.message, req.mapping, df)
        result = run_sel_analysis(
            df,
            req.mapping,
            req.thresholds,
            cohort=req.sel_cohort,
            cohort_grade=req.sel_cohort_grade,
            baseline=req.sel_baseline,
            compare_grades=req.sel_compare_grades,
            compare_dimension=req.sel_compare_dimension,
            compare_grade=req.sel_compare_grade,
            custom_groups=custom_groups,
        )
    elif req.stage == "group_comparison":
        groups = req.custom_groups
        if not groups and req.message:
            groups = resolve_custom_groups(req.message, req.mapping, df, req.prior_list_context)
            print(f"[resolve_custom_groups] result={json.dumps(groups, indent=2)}")
        if not groups:
            raise HTTPException(
                status_code=400,
                detail="Could not identify comparison groups from the request.",
            )
        metric = req.comparison_metric or "indicators"
        result = run_group_comparison(
            df=df,
            mapping=req.mapping,
            groups=groups,
            metric=metric,
            thresholds=req.thresholds,
        )
    elif req.stage == "row_level":
        result = run_row_level_analysis(
            df, req.mapping, req.thresholds, req.message or ''
        )
    elif req.stage == "students":
        message_filters = {}
        if req.message:
            message_filters = resolve_dynamic_filters(req.message, req.mapping, df) or {}
            print(f"[students] message_filters={message_filters}")
            print(f"[students] df before filters={len(df)}")
        result = run_students_analysis(
            df,
            req.mapping,
            req.filter_tier or "all",
            req.thresholds,
            req.grade_filter,
            require_ell=bool(req.require_ell),
            demographic_subset=req.demographic_subset,
            demographic_sort_roles=req.demographic_sort_roles,
            min_suspension_count=req.min_suspension_count,
            min_course_failures=req.min_course_failures,
            sort_by=req.sort_by,
            message_filters=message_filters,
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unknown stage: {req.stage!r}")

    return _sanitize_json(result)