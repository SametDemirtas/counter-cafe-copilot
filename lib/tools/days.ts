// The café's daily record: one entry per calendar day with the till's
// end-of-day totals and the rota that worked it. Sales and staff tools both
// read it, so it lives on its own.

import { z } from "zod";

import { CurrencySchema } from "../domain/money.js";

export const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export const WeekdaySchema = z.enum(WEEKDAYS);
export type Weekday = z.infer<typeof WeekdaySchema>;

export const ShiftSlotSchema = z.enum(["morning", "evening"]);
export type ShiftSlot = z.infer<typeof ShiftSlotSchema>;

export const ShiftSchema = z.object({
  staff: z.string().min(1),
  slot: ShiftSlotSchema,
  costMinor: z.number().int().nonnegative().safe(),
});
export type Shift = z.infer<typeof ShiftSchema>;

export const DAY_MS = 86_400_000;

function utcMidnight(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00Z`);
}

export function weekdayOf(isoDate: string): Weekday {
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(new Date(utcMidnight(isoDate)).getUTCDay() + 6) % 7]!;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(utcMidnight(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

// Calendar days from `from` to `to`, counting both ends.
export function daysInclusive(from: string, to: string): number {
  return (utcMidnight(to) - utcMidnight(from)) / DAY_MS + 1;
}

export function mondayOf(isoDate: string): string {
  return addDays(isoDate, -WEEKDAYS.indexOf(weekdayOf(isoDate)));
}

// The manager's free text on the end-of-day report. Grounding lets an answer
// quote tool text word for word without checking the figures inside the quote,
// so a note must carry no figures at all. Digits are refused in every script,
// matching grounding's own \p{Nd} digit runs.
const NoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\P{Nd}*$/u, "a day note may not contain digits");

// One trading day: sales, transactions and the shifts worked.
export const DayRecordSchema = z
  .object({
    date: z.string().date(),
    dayOfWeek: WeekdaySchema,
    salesMinor: z.number().int().nonnegative().safe(),
    // Orders rung through the till that day.
    transactions: z.number().int().nonnegative().safe(),
    note: NoteSchema.optional(),
    // Empty on a closed day.
    shifts: z.array(ShiftSchema),
  })
  .refine((d) => weekdayOf(d.date) === d.dayOfWeek, {
    message: "dayOfWeek does not match date",
  })
  .refine((d) => (d.salesMinor === 0) === (d.transactions === 0), {
    message: "sales and transactions must both be recorded or both be zero",
  });

export const ShiftsSchema = z.object({
  currency: CurrencySchema,
  days: z
    .array(DayRecordSchema)
    .nonempty()
    // Sorted and unique, so "the latest week" and "a week earlier" are well defined.
    .refine((days) => days.every((d, i) => i === 0 || d.date > days[i - 1]!.date), {
      message: "days must be in date order and each date may appear only once",
    }),
});

export type DayRecord = z.infer<typeof DayRecordSchema>;
export type Shifts = z.infer<typeof ShiftsSchema>;

export function isClosed(day: DayRecord): boolean {
  return day.salesMinor === 0 && day.shifts.length === 0;
}

// Staff worked but the till recorded nothing, e.g. an outage.
export function isSalesMissing(day: DayRecord): boolean {
  return day.salesMinor === 0 && day.shifts.length > 0;
}

export interface DaySpan {
  readonly from: string;
  readonly to: string;
  readonly days: readonly DayRecord[];
}

// Monday to the last recorded day.
export function latestWeek(shifts: Shifts): DaySpan {
  const to = shifts.days[shifts.days.length - 1]!.date;
  const from = mondayOf(to);
  return { from, to, days: shifts.days.filter((d) => d.date >= from) };
}
