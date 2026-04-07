from math_utils import add, multiply


def run(base: int, increment: int) -> int:
    """Apply add then multiply."""
    total = add(base, increment)
    return multiply(total, 2)
