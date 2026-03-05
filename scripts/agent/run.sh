#!/bin/bash
set -euo pipefail

TASK_FILE="$1"
ISSUE_NUMBER_FILE="$2"
ISSUE_NUMBER="$(cat "$ISSUE_NUMBER_FILE" 2>/dev/null || echo 0)"
REPO="${GITHUB_REPOSITORY:-}"
RUN_URL=""
if [[ -n "${GITHUB_RUN_ID:-}" ]] && [[ -n "${REPO}" ]]; then
  RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${REPO}/actions/runs/${GITHUB_RUN_ID}"
fi
AGENT_FAILURE_NOTIFIED=0

post_issue_comment() {
  local comment="$1"
  if [[ "$ISSUE_NUMBER" == "0" ]] || [[ -z "${GITHUB_TOKEN:-}" ]] || [[ -z "$REPO" ]]; then
    return 0
  fi
  local payload
  payload="$(COMMENT_BODY="$comment" python3 - <<'PY'
import json, os
print(json.dumps({"body": os.environ.get("COMMENT_BODY", "")}))
PY
)"
  curl -fsS -X POST \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}/comments" \
    -d "$payload" >/dev/null || true
}

on_error() {
  local exit_code="$?"
  if [[ "$AGENT_FAILURE_NOTIFIED" != "1" ]]; then
    local msg="Agent run failed. Check workflow logs."
    if [[ -n "$RUN_URL" ]]; then
      msg="${msg} ${RUN_URL}"
    fi
    post_issue_comment "$msg"
  fi
  exit "$exit_code"
}
trap on_error ERR

git config user.email "actions-runner@local"
git config user.name "Actions Runner"

TS="$(date +%Y%m%d-%H%M%S)"
if [[ "$ISSUE_NUMBER" != "0" ]]; then
  BRANCH="agent/issue-${ISSUE_NUMBER}-${TS}"
  PR_TITLE="Agent: issue #${ISSUE_NUMBER}"
else
  BRANCH="agent/manual-${TS}"
  PR_TITLE="Agent: manual run ${TS}"
fi

git checkout -b "$BRANCH"

echo "=== TASK ==="
cat "$TASK_FILE"

TASK="$(cat "$TASK_FILE")"
if [[ -z "$TASK" ]]; then
  echo "Task file is empty; aborting."
  AGENT_FAILURE_NOTIFIED=1
  post_issue_comment "Agent run aborted: task was empty."
  exit 1
fi

if [[ "$ISSUE_NUMBER" != "0" ]]; then
  START_MSG="Agent run started by @${GITHUB_ACTOR:-unknown}."
  if [[ -n "$RUN_URL" ]]; then
    START_MSG="${START_MSG} Run: ${RUN_URL}"
  fi
  post_issue_comment "$START_MSG"
fi

if command -v codex >/dev/null 2>&1; then
  codex exec --full-auto "$TASK"
elif command -v claude >/dev/null 2>&1; then
  claude "$TASK"
else
  echo "No agent CLI found."
  AGENT_FAILURE_NOTIFIED=1
  post_issue_comment "Agent run failed: no supported CLI found on runner (`codex`/`claude`)."
  exit 1
fi

git add -A
# Never include workflow temp files or machine noise in agent PRs.
git reset -q -- .agent .DS_Store || true

MAX_CHANGED_FILES="${AGENT_MAX_CHANGED_FILES:-20}"
if ! [[ "$MAX_CHANGED_FILES" =~ ^[0-9]+$ ]]; then
  MAX_CHANGED_FILES=20
fi
CHANGED_FILE_COUNT="$(git diff --cached --name-only | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
if [[ -z "$CHANGED_FILE_COUNT" ]]; then
  CHANGED_FILE_COUNT=0
fi
if (( CHANGED_FILE_COUNT > MAX_CHANGED_FILES )); then
  AGENT_FAILURE_NOTIFIED=1
  post_issue_comment "Agent run stopped for safety: changed ${CHANGED_FILE_COUNT} files (limit ${MAX_CHANGED_FILES}). Please split the request into smaller tasks."
  exit 1
fi

if ! git diff --cached --quiet; then
  git commit -m "$PR_TITLE"
  git push -u origin "$BRANCH"
else
  echo "No changes to commit."
  post_issue_comment "Agent run completed: no code changes were produced."
  exit 0
fi

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN not set; skipping PR creation."
  AGENT_FAILURE_NOTIFIED=1
  post_issue_comment "Agent pushed branch \`${BRANCH}\`, but could not create PR (missing GITHUB_TOKEN)."
  exit 0
fi

API="https://api.github.com/repos/${REPO}/pulls"
BODY="$(cat "$TASK_FILE")"
PAYLOAD="$(PR_TITLE="$PR_TITLE" BRANCH="$BRANCH" BODY="$BODY" python3 - <<'PY'
import json, os
print(json.dumps({
    "title": os.environ["PR_TITLE"],
    "head": os.environ["BRANCH"],
    "base": "main",
    "body": os.environ.get("BODY", ""),
}))
PY
)"

RESPONSE_FILE="$(mktemp)"
HTTP_CODE="$(
  curl -sS -o "${RESPONSE_FILE}" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "${API}" \
    -d "${PAYLOAD}"
)"

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
  echo "PR creation failed with HTTP ${HTTP_CODE}:"
  cat "${RESPONSE_FILE}"
  AGENT_FAILURE_NOTIFIED=1
  post_issue_comment "Agent pushed branch \`${BRANCH}\`, but PR creation failed (HTTP ${HTTP_CODE})."
  exit 1
fi

PR_URL="$(python3 - "${RESPONSE_FILE}" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get("html_url", ""))
PY
)"

if [[ -z "$PR_URL" ]]; then
  echo "PR creation response missing html_url:"
  cat "${RESPONSE_FILE}"
  AGENT_FAILURE_NOTIFIED=1
  post_issue_comment "Agent pushed branch \`${BRANCH}\`, but could not parse PR URL."
  exit 1
fi

echo "Created PR: ${PR_URL}"
post_issue_comment "Agent run complete. Opened PR: ${PR_URL}"
