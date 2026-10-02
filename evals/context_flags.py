"""Pure Phase 1 variant validation; no Harbor or provider imports."""
FEATURES = ('cache', 'shape', 'mask', 'compact', 'read', 'search', 'edit', 'patch', 'lazy', 'route', 'output')


def validate_context_flags(value):
    if not isinstance(value, str):
        raise ValueError('context_flags must be a comma-separated string')
    if value in ('', 'all'):
        return value
    names = value.split(',')
    if len(names) != len(set(names)) or any(name not in FEATURES for name in names):
        raise ValueError('Invalid or duplicate context_flags')
    return value
