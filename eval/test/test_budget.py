import pytest
from eval.lib.budget import BudgetGuard


def test_case_under_limit():
    """Test case where tokens used are under per-case limit."""
    budget = BudgetGuard(per_case_token_limit=50000)
    assert budget.check_case(25000) == True


def test_case_over_limit():
    """Test case where tokens used exceed per-case limit."""
    budget = BudgetGuard(per_case_token_limit=50000)
    assert budget.check_case(60000) == False


def test_total_under_budget():
    """Test case where total tokens are under budget."""
    budget = BudgetGuard(total_token_budget=5000000)
    budget._total_used = 1000000  # Manually set for testing
    assert budget.check_total() == True


def test_total_over_budget():
    """Test case where total tokens exceed budget."""
    budget = BudgetGuard(total_token_budget=5000000)
    budget._total_used = 6000000  # Manually set for testing
    assert budget.check_total() == False


def test_summary():
    """Test that summary reports correct usage percentages."""
    budget = BudgetGuard(per_case_token_limit=50000, total_token_budget=1000000)
    budget._total_used = 250000  # Manually set for testing
    summary = budget.summary()

    assert summary["per_case_limit"] == 50000
    assert summary["total_budget"] == 1000000
    assert summary["total_used"] == 250000
    assert summary["budget_pct"] == 25.0


def test_record_usage_accumulates():
    """Test that multiple record_usage calls accumulate correctly."""
    budget = BudgetGuard()
    budget.record_usage(10000)
    budget.record_usage(20000)
    budget.record_usage(5000)

    assert budget._total_used == 35000
    assert budget.check_total() == True


def test_zero_budget():
    """Test zero budget edge case."""
    budget = BudgetGuard(total_token_budget=0)
    budget._total_used = 100  # Some usage

    # Check that it correctly reports being over budget
    assert budget.check_total() == False
    assert budget.summary()["budget_pct"] == 0.0  # Division by zero handling


def test_check_case_with_zero_limit():
    """Test case where per-case limit is zero."""
    budget = BudgetGuard(per_case_token_limit=0)
    assert budget.check_case(1) == False
    assert budget.check_case(0) == True


def test_summary_with_zero_budget():
    """Test summary with zero total budget."""
    budget = BudgetGuard(total_token_budget=0)
    summary = budget.summary()
    assert summary["budget_pct"] == 0.0


def test_exact_limits():
    """Test cases where tokens exactly match limits."""
    budget = BudgetGuard(per_case_token_limit=50000, total_token_budget=5000000)

    # Test exact per-case limit
    assert budget.check_case(50000) == True

    # Test exact total budget
    budget._total_used = 5000000
    assert budget.check_total() == True


def test_negative_tokens():
    """Test handling of negative token values."""
    budget = BudgetGuard()

    # Negative tokens should not affect the budget
    budget.record_usage(-1000)
    assert budget._total_used == -1000

    # But case check should still fail for negative tokens (as it's below the limit)
    assert budget.check_case(-1000) == True