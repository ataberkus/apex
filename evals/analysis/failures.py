"""Dev-only provisional failure suggestions and explicit human labels."""
import argparse
import json
from pathlib import Path
import re

from .trace_store import load_dev_trace

LABELS = ['wrong entry point', 'tool misuse', 'timeout', 'premature finish',
          'dependency/environment mistake', "didn't verify", 'broke existing behavior',
          'doom loop', 'lost context after compaction', 'other']


def suggest_failure(events):
    for event in events:
        message = event.get('message', {})
        if not isinstance(message, dict) or message.get('role') != 'toolResult' or message.get('isError') is not True:
            continue
        text = '\n'.join(block.get('text', '') for block in message.get('content', []) if isinstance(block, dict) and block.get('type') == 'text')
        for label, pattern in [('timeout', r'timed? out|timeout'),
                               ('tool misuse', r'unknown tool|invalid arguments|validation failed|could not find.*text'),
                               ('dependency/environment mistake', r'command not found|module not found|no module named|not installed')]:
            match = re.search(pattern, text, flags=re.I)
            if match:
                start = max(0, match.start() - 60)
                return {'status': 'provisional', 'label': label, 'evidence': text[start:start + 300],
                        'note': 'An observed symptom does not prove the root cause. Confirm from the full dev trace.'}
    return {'status': 'provisional', 'label': 'other', 'evidence': '', 'note': 'Human review of the dev trace is required.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='ingested attempt directory with metadata.json')
    parser.add_argument('--label', choices=LABELS, help='confirmed human label; omit for a provisional suggestion')
    parser.add_argument('--evidence', help='required with a confirmed label')
    args = parser.parse_args()
    events = load_dev_trace(args.directory)
    if args.label:
        if not args.evidence or not args.evidence.strip():
            parser.error('a confirmed label requires concrete evidence')
        result = {'status': 'human_confirmed', 'label': args.label, 'evidence': args.evidence}
        with (args.directory / 'classification.json').open('x', encoding='utf8') as target:
            json.dump(result, target, indent=2)
            target.write('\n')
    else:
        result = suggest_failure(events)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
