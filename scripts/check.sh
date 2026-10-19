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
# Translations: the template matches the sources, every catalog is complete;
# compiled into locale/ for the tests below (and for running from the source tree).
python3 scripts/i18n.py check
python3 scripts/i18n.py compile locale >/dev/null
node --test tests/model.test.js tests/launcher.test.js tests/airpods.test.js tests/agents.test.js tests/i18n.test.js tests/commands.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py'
