import { Calculator } from './calculator';

export function runCalculations(pairs: Array<[number, number]>): number[] {
  const calc = new Calculator();
  for (const [a, b] of pairs) {
    calc.add(a, b);
  }
  return calc.getHistory();
}
