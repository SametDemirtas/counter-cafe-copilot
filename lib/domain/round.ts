// Rounds half away from zero to `decimals` places; a negative count rounds to
// tens, hundreds and so on. The epsilon absorbs float noise such as
// 0.145 * 100 = 14.499999999999998, so 14.5 rounds to 15 as written.
export function roundTo(value: number, decimals: number): number {
  const sign = value < 0 ? -1 : 1;
  const magnitude = Math.abs(value);
  if (decimals >= 0) {
    const factor = 10 ** decimals;
    return (sign * Math.round(magnitude * factor + 1e-9)) / factor;
  }
  const step = 10 ** -decimals;
  return sign * Math.round(magnitude / step + 1e-9) * step;
}
