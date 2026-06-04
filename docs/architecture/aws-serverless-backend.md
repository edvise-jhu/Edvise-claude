# AWS Serverless Backend Architecture

## Purpose

This document captures the proposed AWS-native backend redesign for EdVise. The goal is to replace the current Vercel + Supabase + Anthropic Files + Google Drive-heavy architecture with a cheaper, more controlled serverless architecture that supports:

- 100 near-term users with roughly 30 simultaneous active users.
- One dev environment and one prod environment.
- Low fixed infrastructure cost when users are inactive.
- User-private CSV tables, with optional school-level sharing.
- Strong privacy boundaries for student data.
- LLM tool calling over controlled backend tools.
- Inline frontend visualizations from structured backend payloads.
- Reference-backed answers over a small system PDF/text corpus.

LLM model usage cost is intentionally treated separately from infrastructure cost.

## Current Problems To Solve

The current repo is a React/Vite frontend plus FastAPI backend. It depends on Supabase for auth, tables, conversations, artifacts, and knowledge-base metadata; Anthropic for chat, analysis, web search, and Files API; and optional Google Picker/Drive for file import.

The planned rewrite should address these issues:

- Debugging crosses too many hosted systems.
- Supabase Auth/Postgres, Anthropic Files, Google Drive, and the app backend form a fragile file/data flow.
- There is no strong backend-enforced privacy gateway between uploaded student data and LLM calls.
- Tool calling needs to drive backend data analysis and frontend visualization, not free-form model output.
- Workflow prompts need to be versioned and selected by frontend buttons or backend routing.

## Recommended AWS Services

Use a serverless-first architecture:

- Frontend hosting: S3 + CloudFront, or Amplify Hosting if simpler CI/CD is preferred.
- Authentication: Amazon Cognito User Pools.
- API layer: API Gateway HTTP API + Lambda.
- Streaming chat: Lambda response streaming or a dedicated Lambda Function URL behind CloudFront.
- App state and catalog: DynamoDB on-demand.
- File storage: S3 raw, curated, and derived buckets/prefixes.
- Table query engine: Athena over S3 Parquet tables, with Lambda + DuckDB as an optional fast path.
- Data processing queue: SQS plus Lambda; Step Functions for multi-step jobs.
- Reference RAG: Bedrock Knowledge Bases with S3 Vectors. Avoid OpenSearch Serverless for the first version because its fixed OCU cost is too high for the current budget.
- LLM runtime: Amazon Bedrock Converse API with tool use.
- Secrets/config: AWS Secrets Manager for secrets, SSM Parameter Store for non-secret config.
- Observability: CloudWatch Logs, CloudWatch metrics/alarms, X-Ray where useful, AWS Budgets.

Avoid for the first version:

- OpenSearch Serverless, unless the fixed base cost becomes acceptable.
- Aurora/RDS, unless there is a clear transactional SQL requirement.
- NAT Gateway, unless a VPC-only service becomes unavoidable.
- Always-on ECS/App Runner services.

## Environment Model

Create isolated dev and prod environments. Prefer separate AWS accounts if available; otherwise use separate stacks, names, KMS keys, buckets, DynamoDB tables, and Cognito pools.

Suggested naming:

- `edvise-dev-*`
- `edvise-prod-*`

Each environment should have:

- Its own Cognito User Pool.
- Its own S3 buckets or environment-scoped bucket prefixes.
- Its own DynamoDB tables.
- Its own Athena workgroup with scan limits.
- Its own Secrets Manager entries.
- Its own CloudWatch alarms and AWS Budgets thresholds.

Expected non-LLM infrastructure cost:

- Dev: approximately USD 5-15/month at low usage.
- Prod: approximately USD 10-40/month for the near-term user target.
- Dev + prod conservative budget: approximately USD 30-80/month, excluding LLM model calls.

The main variable cost after this architecture is Bedrock model usage.

## Data Ownership And Sharing

Every uploaded CSV belongs to an owner user and a school/tenant.

Access modes:

- `private`: only the uploader can query it.
- `school`: users in the same school/tenant can query it, subject to role permissions.
- `admin/system`: reserved for system reference files and administrative workflows.

Cognito claims should include:

- `user_id`
- `school_id`
- `role`

The backend must enforce access on every tool call. Do not rely on frontend visibility or prompt instructions for authorization.

## Storage Layout

Uploaded user CSVs should be stored as raw files and converted into curated analytical tables.

Example S3 layout:

```text
s3://edvise-prod-raw/{school_id}/{user_id}/{dataset_id}/original.csv
s3://edvise-prod-curated/{school_id}/{dataset_id}/table.parquet
s3://edvise-prod-derived/{school_id}/{dataset_id}/profile.json
s3://edvise-prod-derived/{school_id}/{dataset_id}/summaries/foundational_summary.json
s3://edvise-prod-derived/{school_id}/{dataset_id}/summaries/column_stats.json
s3://edvise-prod-derived/{school_id}/{dataset_id}/summaries/join_profile.json
```

Raw files are not exposed to LLM tools. Curated Parquet files should be anonymized and column-normalized.

DynamoDB stores the dataset catalog, not the table data itself.

Example catalog item:

```json
{
  "pk": "SCHOOL#school_123",
  "sk": "DATASET#dataset_abc",
  "dataset_id": "dataset_abc",
  "owner_user_id": "user_456",
  "school_id": "school_123",
  "sharing": "private",
  "raw_s3_key": "school_123/user_456/dataset_abc/original.csv",
  "curated_s3_key": "school_123/dataset_abc/table.parquet",
  "status": "ready",
  "row_count": 12840,
  "schema_version": 3,
  "columns": [
    {
      "safe_name": "grade",
      "type": "category",
      "pii": false,
      "allowed_to_llm": true
    },
    {
      "safe_name": "student_name",
      "type": "string",
      "pii": true,
      "allowed_to_llm": false
    }
  ]
}
```

## Ingestion Pipeline

The upload path should avoid sending file bytes through the API backend.

Flow:

1. Frontend requests a presigned S3 upload URL.
2. Frontend uploads the CSV directly to the raw S3 bucket.
3. S3 event emits a processing job through SQS/EventBridge.
4. Ingestion Lambda or one-off Fargate task validates and profiles the file.
5. The job detects PII columns, column types, possible join keys, and table shape.
6. The job writes anonymized/curated Parquet to S3.
7. The job writes derived summaries and updates DynamoDB status.

For small and medium CSVs, Lambda is likely enough. If processing exceeds Lambda timeout/memory limits, run the same job as an ephemeral Fargate task.

## Anonymization

Student identifiers should be transformed before any analytical query result can be sent to LLM tools.

Recommended rules:

- Replace direct identifiers with stable anonymous IDs.
- Drop or mask PII columns in curated Parquet.
- Store reversible mappings separately, encrypted with KMS, and only accessible to narrow backend functions.
- Apply small-cell suppression for aggregate results, for example hiding or coarsening groups where `n < 5`.
- Keep raw files out of LLM-accessible tools.

Privacy modes for tool calls:

- `aggregate_only`: default. Returns aggregates and charts only.
- `anonymous_rows`: returns row data with anonymous IDs and no PII columns.
- `frontend_only_rows`: returns rows to the frontend, while the LLM only receives a summary.
- `identified_rows`: avoid by default; require explicit role, workflow, and audit logging.

## Athena And Summaries

Athena is the SQL engine for querying curated S3 Parquet tables. It should handle:

- Filters.
- Group by and aggregates.
- Joins across uploaded datasets.
- Metric calculations.
- Table/chart result generation.

Athena should not be called for every user message. Use a three-level query strategy:

1. Summary/cache hit: read a precomputed JSON summary or cached query result.
2. Interactive query: use Athena or Lambda + DuckDB for bounded filter/groupby/join work.
3. Async job: queue large or expensive analysis and report progress to the frontend.

Precomputed summary files are small derived JSON/Parquet outputs created after upload or after common workflows.

Examples:

- `dataset_profile.json`: row count, column types, missing values, safe schema, possible join keys.
- `foundational_summary.json`: total students, chronic absence counts/rates, suspension rates, course failure rates, grade breakdowns, flag overlap.
- `column_stats.json`: numeric ranges, categorical top values, histograms.
- `join_profile.json`: candidate relationships with other uploaded tables and match rates.

This keeps common questions fast and cheap:

- "Which grade has the highest chronic absence?"
- "How many students have all three flags?"
- "Show absence by grade."

Only questions requiring new filters, joins, or custom analysis should trigger Athena.

Use Athena workgroups with scan limits in dev and prod.

## Join Model

Do not let the LLM guess arbitrary joins.

The ingestion pipeline should detect candidate join keys and produce a join profile. The app should either:

- Ask the user to confirm relationships once, or
- Allow an admin/school data manager to approve relationships.

Tool calls can then reference approved `join_id` values.

Example:

```json
{
  "tool": "run_joined_analysis",
  "args": {
    "left_dataset_id": "attendance_2025",
    "right_dataset_id": "sel_2025",
    "join_id": "anonymous_student_id",
    "group_by": ["grade", "ell"],
    "metrics": ["avg_attendance_rate", "avg_belonging_score"],
    "privacy_mode": "aggregate_only"
  }
}
```

The backend compiles this into validated SQL or a validated query plan.

## Tool Calling Architecture

The LLM should never directly access S3, DynamoDB, Athena, or raw data.

All model tool requests go through a backend Tool Gateway:

```text
Bedrock Converse API
  -> tool request
  -> Tool Gateway
  -> auth/privacy/policy validation
  -> query execution or RAG retrieval
  -> structured result
  -> model and/or frontend event stream
```

Initial tool set:

- `list_available_datasets`
- `get_safe_dataset_profile`
- `run_aggregate_query`
- `run_filtered_table_query`
- `run_joined_analysis`
- `get_precomputed_summary`
- `create_visualization`
- `retrieve_reference_chunks`
- `generate_artifact`

Every tool should declare:

- Allowed workflows.
- Required permissions.
- Privacy mode.
- Maximum result rows.
- Whether results may be shown to the LLM, frontend, or both.

## Frontend Visualization Contract

Do not ask the LLM to output arbitrary chart markup.

The backend should emit structured event payloads:

```text
text_delta
tool_status
table_data
chart_spec
artifact
citations
error
done
```

For data tools, separate model-safe output from UI output:

```json
{
  "llm_payload": {
    "summary": "Grade 7 has the highest chronic absence rate.",
    "numbers": [
      {"grade": "7", "rate": 0.23, "n": 184}
    ]
  },
  "ui_payload": {
    "type": "chart",
    "chart_spec": {
      "chart_type": "bar",
      "x": "grade",
      "y": "chronic_absence_rate"
    },
    "table_rows": [
      {"grade": "7", "chronic_absence_rate": 0.23, "n": 184}
    ]
  }
}
```

The frontend renders charts and tables from fixed schemas. The LLM can request a chart, but the backend decides what data is safe to send.

## Workflow Prompt Registry

Frontend buttons should not send full prompts. They should send workflow IDs.

Example:

```json
{
  "workflow_id": "foundational_analysis",
  "dataset_ids": ["dataset_abc"],
  "user_message": "Run the overview."
}
```

The backend workflow registry defines:

- System prompt version.
- Allowed tools.
- Allowed privacy modes.
- Model choice.
- Reference policy.
- Output schemas.
- Error/fallback behavior.

Example workflows:

- `specific_question`
- `foundational_analysis`
- `subgroup_analysis`
- `wellbeing_analysis`
- `intervention_brainstorm`
- `action_plan`
- `meeting_agenda`
- `report`

This makes prompts testable and versioned.

## Reference Documents And RAG

System PDF/text reference documents should live in S3 and be indexed for retrieval.

Recommended first version:

- Bedrock Knowledge Bases with S3 Vectors.
- Source documents in S3.
- Chunking and embedding handled by the managed KB pipeline where possible.
- Retrieval returns source metadata for citations.

Avoid stuffing full PDFs into the LLM context. Retrieve relevant chunks and provide citations.

Reference source policy should be explicit:

- `data_only`
- `reference_only`
- `data_plus_reference`

The frontend can expose this as a button/toggle. The backend can also auto-enable reference retrieval for intervention, evidence, research, or best-practice questions, but the final policy should be auditable.

## Cost Controls

Required controls for the first version:

- AWS Budgets for dev and prod.
- Athena workgroup scan limits.
- Per-tenant daily LLM token quota.
- Per-tenant query quota.
- SQS queues for expensive jobs.
- Lambda reserved concurrency for ingestion and analysis.
- Query result caching by `dataset_id + workflow_id + query_plan_hash`.
- Default to cheaper Bedrock models for routing, summarization, and simple answers.

Infrastructure budget excluding LLM calls:

- Dev: target USD 5-15/month.
- Prod: target USD 10-40/month.
- Combined conservative target: USD 30-80/month.

## Deployment And Branch Behavior

The current repository has no local Vercel configuration files. Vercel behavior is therefore controlled by the Vercel project settings.

With Vercel's default Git integration:

- The configured production branch, commonly `main`, deploys to production.
- Other pushed branches create Preview Deployments.
- Preview Deployments do not replace the production domain.

If the goal is to prevent non-main branch builds entirely, configure Vercel's Ignored Build Step or project branch settings in the Vercel dashboard.

## Open Decisions

- Whether dev and prod should use separate AWS accounts or separate stacks in one account.
- Whether the frontend should be hosted by Amplify Hosting or S3 + CloudFront.
- Whether Athena should be the only interactive query engine, or whether Lambda + DuckDB should be used as a faster path for small datasets.
- Whether reference retrieval is user-selected, automatically selected by workflow, or both.
- Exact small-cell suppression threshold.
- Exact row limit for `anonymous_rows` and `frontend_only_rows` tool payloads.

## First Implementation Milestones

1. Build AWS IaC skeleton for dev/prod.
2. Add Cognito auth and protected API Gateway routes.
3. Implement S3 presigned upload flow.
4. Implement ingestion to curated Parquet plus DynamoDB catalog.
5. Implement summary generation.
6. Implement Athena workgroup and validated query runner.
7. Implement Bedrock Converse tool gateway.
8. Implement visualization event schema.
9. Implement reference KB with S3 Vectors.
10. Migrate frontend workflows to call workflow IDs instead of prompt-shaped backend endpoints.
