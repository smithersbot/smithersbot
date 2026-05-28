#!/usr/bin/env bash
# Script to verify failed resume functionality
# Per CLAUDE.md: "Self-Verification Requirement for /goal Changes"

set -e

echo "=== Verifying Failed Resume Implementation ==="
echo ""

# Test 1: Create a mock failed planning run
TEST_RUN_ID="test-$(date +%s)"
TEST_DIR="$HOME/.moltbot/goals/$TEST_RUN_ID"

echo "Creating test run: $TEST_RUN_ID"
mkdir -p "$TEST_DIR"

cat > "$TEST_DIR/run.json" <<EOF
{
  "runId": "$TEST_RUN_ID",
  "goal": "Test goal for failed resume verification",
  "state": "failed",
  "lastError": "Simulated planning failure for testing",
  "workingDir": "/tmp/test-workspace",
  "model": "claude-sonnet-4-5-20250929",
  "dryRun": false,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "plan": null,
  "stepResults": {},
  "answers": {},
  "blocked": null
}
EOF

echo "✓ Created test run in failed state with no plan"
echo ""

# Test 2: Verify resume without --replan suggests the flag
echo "Test 1: Resume without --replan (should suggest flag)"
echo "Running: node scripts/run-node.mjs goal resume $TEST_RUN_ID"
if node scripts/run-node.mjs goal resume "$TEST_RUN_ID" 2>&1 | tee /tmp/resume-test-1.txt | grep -q "Use --replan"; then
  echo "✓ Correctly suggests --replan flag"
else
  echo "✗ Failed to suggest --replan flag"
  cat /tmp/resume-test-1.txt
  exit 1
fi
echo ""

# Test 3: Verify JSON mode outputs structured error
echo "Test 2: Resume in JSON mode (should output structured error)"
echo "Running: node scripts/run-node.mjs goal resume $TEST_RUN_ID --json"
if node scripts/run-node.mjs goal resume "$TEST_RUN_ID" --json 2>&1 | tee /tmp/resume-test-2.txt | jq -e '.error' > /dev/null 2>&1; then
  echo "✓ JSON mode outputs structured error"
  cat /tmp/resume-test-2.txt | jq .
else
  echo "✗ JSON mode did not output valid structured error"
  cat /tmp/resume-test-2.txt
  exit 1
fi
echo ""

# Test 4: Create a run in 'planning' state
TEST_RUN_ID_2="test-planning-$(date +%s)"
TEST_DIR_2="$HOME/.moltbot/goals/$TEST_RUN_ID_2"

echo "Test 3: Create run in 'planning' state"
mkdir -p "$TEST_DIR_2"

cat > "$TEST_DIR_2/run.json" <<EOF
{
  "runId": "$TEST_RUN_ID_2",
  "goal": "Test goal stuck in planning state",
  "state": "planning",
  "workingDir": "/tmp/test-workspace",
  "model": "claude-sonnet-4-5-20250929",
  "dryRun": false,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "plan": null,
  "stepResults": {},
  "answers": {},
  "blocked": null
}
EOF

echo "Running: node scripts/run-node.mjs goal resume $TEST_RUN_ID_2"
if node scripts/run-node.mjs goal resume "$TEST_RUN_ID_2" 2>&1 | tee /tmp/resume-test-3.txt | grep -q "incomplete state"; then
  echo "✓ Correctly detects incomplete planning state"
else
  echo "✗ Failed to detect incomplete planning state"
  cat /tmp/resume-test-3.txt
  exit 1
fi
echo ""

# Test 5: Verify failed run with blocked steps transitions to blocked state
TEST_RUN_ID_3="test-exec-$(date +%s)"
TEST_DIR_3="$HOME/.moltbot/goals/$TEST_RUN_ID_3"

echo "Test 4: Create failed execution run with blocked steps"
mkdir -p "$TEST_DIR_3"

cat > "$TEST_DIR_3/run.json" <<EOF
{
  "runId": "$TEST_RUN_ID_3",
  "goal": "Test goal that failed during execution",
  "state": "failed",
  "lastError": "Task execution failed",
  "workingDir": "/tmp/test-workspace",
  "model": "claude-sonnet-4-5-20250929",
  "dryRun": false,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "plan": {
    "steps": [
      {
        "id": "step1",
        "description": "First step",
        "dependsOn": [],
        "status": "done",
        "taskSummary": "Completed"
      },
      {
        "id": "step2",
        "description": "Failed step",
        "dependsOn": ["step1"],
        "status": "blocked",
        "blockedReason": "task_failed",
        "blockedQuestion": "Step failed"
      }
    ]
  },
  "stepResults": {
    "step1": {
      "stepId": "step1",
      "success": true,
      "output": "Done",
      "durationMs": 1000
    }
  },
  "answers": {},
  "blocked": null
}
EOF

echo "Running: node scripts/run-node.mjs goal resume $TEST_RUN_ID_3"
if node scripts/run-node.mjs goal resume "$TEST_RUN_ID_3" 2>&1 | tee /tmp/resume-test-4.txt | grep -q "Blocked:"; then
  echo "✓ Failed execution run transitioned to blocked state"

  # Verify persistence
  if grep -q '"state": "blocked"' "$TEST_DIR_3/run.json"; then
    echo "✓ State persisted correctly"
  else
    echo "✗ State not persisted"
    exit 1
  fi
else
  echo "✗ Failed to transition failed execution run"
  cat /tmp/resume-test-4.txt
  exit 1
fi
echo ""

# Cleanup
echo "Cleaning up test runs..."
rm -rf "$TEST_DIR" "$TEST_DIR_2" "$TEST_DIR_3"
rm -f /tmp/resume-test-*.txt
echo "✓ Cleanup complete"
echo ""

echo "=== All Verification Tests Passed ==="
echo ""
echo "Summary:"
echo "  ✓ Failed planning runs suggest --replan flag"
echo "  ✓ JSON mode outputs structured errors"
echo "  ✓ Planning state runs are detected correctly"
echo "  ✓ Failed execution runs transition to blocked state"
echo "  ✓ State transitions are persisted correctly"
echo ""
echo "Implementation verified successfully!"
