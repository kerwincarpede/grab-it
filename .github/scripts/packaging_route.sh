#!/usr/bin/env bash
set -eu
package=true
if [[ $GITHUB_EVENT_NAME == pull_request ]]; then
  # Count both sides of renames in the tested merge tree's diff.
  git diff --no-renames --name-only -z HEAD^1 HEAD > "$RUNNER_TEMP/pr-paths"
  package=false
  while IFS= read -r -d '' path; do
    case "$path" in
      src/grab-it/src-tauri/src/bin/*) package=true; break ;;
      src/grab-it/src-tauri/src/*|src/grab-it/src-tauri/tests/*|src/grab-it/src-tauri/benches/*) ;;
      .github/scripts/*bench_report.py|.github/workflows/bench.yml|.github/workflows/docs.yml) ;;
      src/grab-it/src-tauri/*|.github/scripts/*|.github/workflows/*.yml|*/package.json|package.json|package-lock.json|dev-install.sh|.cargo/*|*/.cargo/*|.gitattributes)
        package=true; break ;;
    esac
  done < "$RUNNER_TEMP/pr-paths"
elif [[ $GITHUB_EVENT_NAME == workflow_dispatch && $MANUAL_PACKAGE == false ]]; then
  package=false
fi
echo "package=$package"
