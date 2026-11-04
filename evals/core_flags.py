"""Pure Phase 2 variant validation; never imports a provider or Harbor."""
import math
from decimal import Decimal

FEATURES=('snapshot','entrypoints','headless','contract','todo','verify','loops','bg','time','correct','diagnostics','subagents','max','recovery')

def validate_core_flags(value):
    if not isinstance(value,str):raise ValueError('core_flags must be a comma-separated string')
    if value in ('','all'):return value
    names=value.split(',')
    if len(names)!=len(set(names)) or any(name not in FEATURES for name in names):raise ValueError('Invalid or duplicate core_flags')
    return value

def selected_core_flags(value):
    validate_core_flags(value)
    return FEATURES if value=='all' else tuple(value.split(',')) if value else ()

def validate_time_budget(value):
    if value is None:return None
    if isinstance(value,bool) or not isinstance(value,(int,float,str)):raise ValueError('time_budget_sec must be positive seconds')
    try:seconds=float(value)
    except (TypeError,ValueError) as exc:raise ValueError('time_budget_sec must be positive seconds') from exc
    if not math.isfinite(seconds) or not 0<seconds<=86400:raise ValueError('time_budget_sec must be at most 86400 positive seconds')
    return seconds

def format_time_budget(value):
    """Use decimal seconds accepted by the launcher's strict parser."""
    seconds=validate_time_budget(value)
    if seconds is None:raise ValueError('A concrete time budget is required')
    return format(Decimal(str(seconds)),'f')
