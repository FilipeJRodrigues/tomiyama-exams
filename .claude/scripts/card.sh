#!/usr/bin/env bash
# Move a card of the "Tomiyama Exams" board and/or comment on its issue.
#
# Usage:
#   bash .claude/scripts/card.sh <issue> <status> [comment]
#   bash .claude/scripts/card.sh <issue> - <comment>      # comment only
#
# <status>: "Backlog", "A fazer", "Em andamento", "Em QA" or "Pronto".
# The comment is posted on the issue (Markdown). Never put real e-mails,
# student data, secrets or account IDs in it.
set -euo pipefail

REPO=FilipeJRodrigues/tomiyama-exams
OWNER=FilipeJRodrigues
PROJECT_NUMBER=1
PROJECT_ID=PVT_kwHOCIlAB84Bp6j3
STATUS_FIELD=PVTSSF_lAHOCIlAB84Bp6j3zhoT-Hg

issue=${1:?informe o número da issue}
status=${2:?informe o status ou "-"}
comment=${3:-}

case "$status" in
  "Backlog") option=2d032663 ;;
  "A fazer") option=792439bc ;;
  "Em andamento") option=f7f5eecb ;;
  "Em QA") option=72eb2062 ;;
  "Pronto") option=914a3b3d ;;
  "-") option= ;;
  *) echo "status inválido: $status" >&2; exit 2 ;;
esac

if [ -n "$option" ]; then
  url="https://github.com/$REPO/issues/$issue"
  # item-add returns the existing item when the issue is already on the board.
  item=$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --format json --jq .id)
  gh project item-edit --id "$item" --project-id "$PROJECT_ID" \
    --field-id "$STATUS_FIELD" --single-select-option-id "$option" >/dev/null
  echo "#$issue -> $status"
fi

if [ -n "$comment" ]; then
  gh issue comment "$issue" --repo "$REPO" --body "$comment" >/dev/null
  echo "#$issue: comentário publicado"
fi
