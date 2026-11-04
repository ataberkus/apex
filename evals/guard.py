"""Offline cost preflight. This module never launches a benchmark."""
from decimal import Decimal
import math


def _amount(value, name, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f'{name} must be a finite USD number')
    if value < 0 or (positive and value == 0):
        raise ValueError(f'{name} must be {"positive" if positive else "nonnegative"}')
    return Decimal(str(value))


def validate_budget(config, estimate_usd, spent_usd=0, reserved_usd=0):
    if config.get('execution_policy') == 'offline-only':
        raise ValueError('offline-only policy blocks paid evaluations')
    cap = _amount(config.get('budget_cap_usd'), 'budget cap')
    estimate = _amount(estimate_usd, 'estimated cost', positive=True)
    spent = _amount(spent_usd, 'spent cost')
    reserved = _amount(reserved_usd, 'reserved cost')
    if cap == 0:
        raise ValueError('budget cap is $0; paid evaluations are blocked')
    if config.get('paid_runs_enabled') is not True:
        raise ValueError('paid runs are not enabled in the configuration')
    remaining = cap - spent - reserved - estimate
    if remaining < 0:
        raise ValueError('estimated run exceeds remaining budget including reservations')
    return float(remaining)
