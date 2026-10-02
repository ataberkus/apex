"""Pure Phase 3 variant validation; never imports providers or Harbor."""

FEATURES = ('cost', 'checkpoints', 'review', 'plan', 'remember', 'skills', 'safety', 'report', 'resume')


def validate_feature_flags(value):
    if not isinstance(value, str):
        raise ValueError('feature_flags must be a comma-separated string')
    if value in ('', 'all'):
        return value
    names = value.split(',')
    if len(names) != len(set(names)) or any(name not in FEATURES for name in names):
        raise ValueError('Invalid or duplicate feature_flags')
    return value


def selected_feature_flags(value):
    validate_feature_flags(value)
    return FEATURES if value == 'all' else tuple(value.split(',')) if value else ()
