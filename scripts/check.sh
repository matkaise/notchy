#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
while IFS= read -r file; do node --check "$file"; done < <(find . -name '*.js' -not -path './.git/*')
glib-compile-schemas --strict --dry-run schemas
python3 - <<'PY'
import ast
from pathlib import Path
for path in Path('helper').glob('*.py'):
    ast.parse(path.read_text(), filename=str(path))
PY
node --test tests/model.test.js tests/launcher.test.js tests/airpods.test.js tests/agents.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'
