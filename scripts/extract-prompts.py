"""Copy the user's supplied prompt blocks verbatim; no runtime prompt activation."""
from pathlib import Path
import re

source = Path('APEX_BUILD.md').read_text(encoding='utf8')
names = ['system.md', 'mode-headless.md', 'mode-interactive.md', 'explore.md', 'verify.md',
         'compaction.md', 'contract.md', 'verification-gate.md', 'loop-breaker.md', 'time-note.md']
section = source.split('## 6. Runtime prompts\n', 1)[1].split('## 7. Phase 4', 1)[0]
blocks = re.findall(r'```text\n(.*?)\n```', section, re.S)
if len(blocks) != len(names):
    raise ValueError('Expected exactly ten supplied prompt blocks')
Path('prompts').mkdir(exist_ok=True)
for name, block in zip(names, blocks):
    Path('prompts', name).write_text(block + '\n', encoding='utf8')
print('Copied ten supplied prompt files; all remain inactive in Phase 0.')
