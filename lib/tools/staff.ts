import { type DayRecord, type Shift, type Weekday, isSalesMissing } from "./days.js";

// Anything with a list of days: the whole record or one week of it.
export interface DayRecords {
  readonly days: readonly DayRecord[];
}

export interface StaffCostRatio {
  readonly date: string;
  readonly dayOfWeek: Weekday;
  readonly staffCostMinor: number;
  readonly salesMinor: number;
  readonly shifts: readonly Shift[];
  readonly staffCount: number;
  // 0 with no sales, which would look like a perfect day; see salesMissing.
  readonly ratioPct: number;
  readonly salesMissing: boolean;
}

function dayCostMinor(day: DayRecord): number {
  const total = day.shifts.reduce((sum, s) => sum + s.costMinor, 0);
  if (!Number.isSafeInteger(total)) {
    throw new RangeError(`Staff cost for ${day.date} exceeds the safe integer range`);
  }
  return total;
}

export function staffCostRatios(record: DayRecords): StaffCostRatio[] {
  return record.days.map((day) => {
    const staffCostMinor = dayCostMinor(day);
    const staff = new Set(day.shifts.map((s) => s.staff));
    return {
      date: day.date,
      dayOfWeek: day.dayOfWeek,
      staffCostMinor,
      salesMinor: day.salesMinor,
      shifts: day.shifts,
      staffCount: staff.size,
      ratioPct: day.salesMinor === 0 ? 0 : staffCostMinor / day.salesMinor,
      salesMissing: isSalesMissing(day),
    };
  });
}

// Staff cost with no sales beats any real ratio.
function isWorse(candidate: StaffCostRatio, incumbent: StaffCostRatio): boolean {
  if (candidate.salesMissing !== incumbent.salesMissing) return candidate.salesMissing;
  return candidate.ratioPct > incumbent.ratioPct;
}

export function worstStaffDay(record: DayRecords): StaffCostRatio | null {
  return staffCostRatios(record).reduce<StaffCostRatio | null>(
    (worst, current) => (worst === null || isWorse(current, worst) ? current : worst),
    null,
  );
}

// The highest ratio among days the till recorded, so a normal trading day can
// be named even when an outage day ranks first in worstStaffDay.
export function worstTradingDay(record: DayRecords): StaffCostRatio | null {
  return staffCostRatios(record)
    .filter((d) => d.salesMinor > 0)
    .reduce<StaffCostRatio | null>((worst, d) => (worst === null || d.ratioPct > worst.ratioPct ? d : worst), null);
}
