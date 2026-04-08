from dataclasses import dataclass, field

@dataclass
class BudgetGuard:
    per_case_token_limit: int = 50000
    total_token_budget: int = 5000000
    _total_used: int = field(default=0, repr=False)

    def check_case(self, tokens_used: int) -> bool:
        """Check if a single case is within its token limit."""
        return tokens_used <= self.per_case_token_limit

    def check_total(self) -> bool:
        """Check if total usage is within budget."""
        return self._total_used <= self.total_token_budget

    def record_usage(self, tokens: int) -> None:
        """Record token usage."""
        self._total_used += tokens

    def summary(self) -> dict:
        """Return budget usage summary."""
        return {
            "per_case_limit": self.per_case_token_limit,
            "total_budget": self.total_token_budget,
            "total_used": self._total_used,
            "budget_pct": round(self._total_used / self.total_token_budget * 100, 1) if self.total_token_budget else 0.0,
        }