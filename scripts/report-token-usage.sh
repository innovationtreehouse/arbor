#!/usr/bin/env bash
# Posts a token-usage/cost comment from a claude-code-action execution file.
# Env: EXEC_FILE, ENTITY_TYPE (issue|pr), ENTITY_NUMBER, REPO, GITHUB_TOKEN.
# Shared by every job in claude.yml — fix jq extraction here, once.
set -euo pipefail

# The result entry's cost field is total_cost_usd (older action versions wrote cost_usd).
cost=$(jq -r '[.[] | select(.type == "result") | (.total_cost_usd // .cost_usd // 0)] | last // 0' "$EXEC_FILE" 2>/dev/null || echo "0")
in_tok=$(jq '[.[] | select(.type == "assistant") | (.message.usage.input_tokens // 0)] | add // 0' "$EXEC_FILE" 2>/dev/null || echo "0")
out_tok=$(jq '[.[] | select(.type == "assistant") | (.message.usage.output_tokens // 0)] | add // 0' "$EXEC_FILE" 2>/dev/null || echo "0")
cache_r=$(jq '[.[] | select(.type == "assistant") | (.message.usage.cache_read_input_tokens // 0)] | add // 0' "$EXEC_FILE" 2>/dev/null || echo "0")
cache_w=$(jq '[.[] | select(.type == "assistant") | (.message.usage.cache_creation_input_tokens // 0)] | add // 0' "$EXEC_FILE" 2>/dev/null || echo "0")
total_in=$(( ${in_tok:-0} + ${cache_r:-0} + ${cache_w:-0} ))
body="**Claude token usage:** ${total_in} in (${in_tok} direct + ${cache_w} cache write + ${cache_r} cache read) • ${out_tok} out • cost: \$${cost}"
gh "$ENTITY_TYPE" comment "$ENTITY_NUMBER" --repo "$REPO" --body "$body"
