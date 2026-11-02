const percentFormatters = new Map<number, Intl.NumberFormat>();

/** `72.5` → `72,5%` (value already in percent, 0–100). */
export function formatPercent(value: number, fractionDigits = 1): string {
  let formatter = percentFormatters.get(fractionDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('pt-BR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: fractionDigits,
    });
    percentFormatters.set(fractionDigits, formatter);
  }
  return `${formatter.format(value)}%`;
}
