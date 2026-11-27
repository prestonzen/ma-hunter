// Can the cash flow carry the debt, and how far can it fall before it can't? Pure arithmetic, shared
// by the Worker and the React app. The assumptions are the buyer's own; nothing here is a quote.

export interface Underwriting {
  /** Cash down, percent of price. */
  downPct: number;
  /** Loan rate, percent a year. */
  ratePct: number;
  termYears: number;
  /** Closing costs, fees and working capital, percent of price, paid in cash. */
  closingPct: number;
  /** Pay someone to do the owner's hours (true), or work them yourself (false). */
  replaceOwner: boolean;
  /** What a full-time (40 hours a week) operator costs a year. */
  managerSalary: number;
  /** The bad year: earnings fall by this percent. */
  stressPct: number;
}

export const DEFAULT_UNDERWRITING: Underwriting = { downPct: 20, ratePct: 11, termYears: 10, closingPct: 3, replaceOwner: true, managerSalary: 70_000, stressPct: 25 };

export interface Underwritten {
  /** Earnings after paying for the owner's hours. */
  adjusted: number;
  ownerCost: number;
  /** False when the listing doesn't state the owner's hours, so no cost was taken off. */
  hoursKnown: boolean;
  cashIn: number;
  loan: number;
  debtService: number;
  /** Debt service coverage: adjusted earnings over debt service. Lenders usually want 1.25 or better. */
  dscr: number | null;
  /** Coverage in the bad year. */
  stressedDscr: number | null;
  /** How far stated earnings can fall before they no longer cover the debt and the operator: 0.3 is 30%. */
  cushion: number;
  /** What is left after debt, over the cash put in. */
  cashOnCash: number | null;
  paybackYears: number | null;
}

/** Annual payment on an amortising loan. */
export function annualPayment(principal: number, ratePct: number, years: number): number {
  if (principal <= 0 || years <= 0) return 0;
  const r = ratePct / 100 / 12;
  const n = years * 12;
  return (r === 0 ? principal / n : (principal * r) / (1 - Math.pow(1 + r, -n))) * 12;
}

export function underwrite(l: { askingPrice: number | null; earnings: number | null; ownerHours: number | null }, u: Underwriting): Underwritten | null {
  const price = l.askingPrice ?? 0;
  const earnings = l.earnings ?? 0;
  if (price <= 0 || earnings <= 0) return null;
  const hoursKnown = l.ownerHours != null;
  const ownerCost = u.replaceOwner && hoursKnown ? u.managerSalary * Math.min(1.5, Math.max(0, l.ownerHours!) / 40) : 0;
  const adjusted = earnings - ownerCost;
  const loan = price * Math.max(0, 1 - u.downPct / 100);
  const cashIn = price * (u.downPct / 100 + u.closingPct / 100);
  const debtService = annualPayment(loan, u.ratePct, u.termYears);
  const left = adjusted - debtService;
  return {
    adjusted, ownerCost, hoursKnown, cashIn, loan, debtService,
    dscr: debtService > 0 ? adjusted / debtService : null,
    stressedDscr: debtService > 0 ? (earnings * (1 - u.stressPct / 100) - ownerCost) / debtService : null,
    cushion: 1 - (debtService + ownerCost) / earnings,
    cashOnCash: cashIn > 0 ? left / cashIn : null,
    paybackYears: left > 0 && cashIn > 0 ? cashIn / left : null,
  };
}
