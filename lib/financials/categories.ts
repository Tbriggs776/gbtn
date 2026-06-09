// Canonical line-item categories for P&L and Balance Sheet, plus the heuristic
// that guesses a category from a raw row label.

export type StatementType = "pl" | "bs";

export type Category = {
  key: string;
  label: string;
  group: "income" | "expense" | "asset" | "liability" | "equity" | "ignore";
};

export const PL_CATEGORIES: Category[] = [
  { key: "revenue", label: "Revenue", group: "income" },
  { key: "cogs", label: "Cost of Goods / Direct Costs", group: "expense" },
  { key: "opex", label: "Operating Expense (overhead)", group: "expense" },
  { key: "depreciation_amortization", label: "Depreciation & Amortization", group: "expense" },
  { key: "interest", label: "Interest", group: "expense" },
  { key: "taxes", label: "Taxes", group: "expense" },
  { key: "other_income", label: "Other Income", group: "income" },
  { key: "other_expense", label: "Other Expense", group: "expense" },
  { key: "exclude", label: "Exclude (subtotal / ignore)", group: "ignore" },
];

export const BS_CATEGORIES: Category[] = [
  { key: "cash", label: "Cash & Equivalents", group: "asset" },
  { key: "accounts_receivable", label: "Accounts Receivable", group: "asset" },
  { key: "inventory", label: "Inventory", group: "asset" },
  { key: "other_current_asset", label: "Other Current Asset", group: "asset" },
  { key: "non_current_asset", label: "Non-Current / Fixed Asset", group: "asset" },
  { key: "accounts_payable", label: "Accounts Payable", group: "liability" },
  { key: "other_current_liability", label: "Other Current Liability", group: "liability" },
  { key: "non_current_liability", label: "Long-Term Liability / Debt", group: "liability" },
  { key: "equity", label: "Equity", group: "equity" },
  { key: "exclude", label: "Exclude (subtotal / ignore)", group: "ignore" },
];

export function categoriesFor(type: StatementType): Category[] {
  return type === "pl" ? PL_CATEGORIES : BS_CATEGORIES;
}

export function categoryLabel(type: StatementType, key: string): string {
  return categoriesFor(type).find((c) => c.key === key)?.label ?? key;
}

export function normalizeLabel(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

// Keyword rules, evaluated in order. First match wins.
const PL_RULES: [RegExp, string][] = [
  [/\b(total|subtotal|gross profit|net (income|profit|loss)|net ordinary|operating income)\b/, "exclude"],
  [/\b(depreciation|amortization|amortisation)\b/, "depreciation_amortization"],
  [/\binterest\b/, "interest"],
  [/\b(income tax|tax expense|taxes|provision for tax)\b/, "taxes"],
  [/\b(cost of (goods|sales|revenue)|cogs|direct costs?|materials?|subcontractors?|sub-?contractors?|job costs?|labor costs?|direct labor|installation|equipment cost)\b/, "cogs"],
  [/\b(other income|interest income|gain on)\b/, "other_income"],
  [/\b(other expense|loss on)\b/, "other_expense"],
  [/\b(revenue|sales|income|fees earned|service income)\b/, "revenue"],
  [/\b(payroll|wages|salar|rent|insurance|utilit|office|marketing|advertis|fuel|vehicle|repairs|supplies|software|dues|travel|meals|professional|legal|accounting|bank charge|merchant|overhead|admin|g&a|sg&a|operating expense)\b/, "opex"],
];

const BS_RULES: [RegExp, string][] = [
  [/\b(total|subtotal)\b/, "exclude"],
  [/\b(cash|checking|savings|bank|money market|petty cash)\b/, "cash"],
  [/\b(accounts? receivable|a\/r|trade receivable|receivable)\b/, "accounts_receivable"],
  [/\b(inventory|stock on hand|work in process|wip)\b/, "inventory"],
  [/\b(accounts? payable|a\/p|trade payable|payable)\b/, "accounts_payable"],
  [/\b(retained earnings|owner|equity|capital|common stock|distributions|member)\b/, "equity"],
  [/\b(long.?term|note payable|loan|mortgage|line of credit|deferred|bond)\b/, "non_current_liability"],
  [/\b(accrued|credit card|current liabilit|payroll liabilit|sales tax|unearned|customer deposit)\b/, "other_current_liability"],
  [/\b(property|equipment|vehicle|building|land|fixed asset|furniture|intangible|goodwill|depreciation)\b/, "non_current_asset"],
  [/\b(prepaid|current asset|undeposited|other receivable|short.?term invest)\b/, "other_current_asset"],
];

export function guessCategory(type: StatementType, rawLabel: string): string {
  const norm = normalizeLabel(rawLabel);
  const rules = type === "pl" ? PL_RULES : BS_RULES;
  for (const [re, cat] of rules) {
    if (re.test(norm)) return cat;
  }
  return "exclude";
}
