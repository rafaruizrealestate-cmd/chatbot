import { config } from "../config.js";

function madridTimeParts(now: Date): { weekday: number; hour: number; minute: number } {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(now);
  const weekdayTxt = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return { weekday: weekdayMap[weekdayTxt] ?? 1, hour, minute };
}

/** Horario de oficina tal y como se le dice al cliente. */
export const OFFICE_HOURS_LABEL = "de lunes a viernes, de 10:00 a 19:30";

/** Oficina abierta en Málaga ahora mismo (al margen de BYPASS_WORK_SCHEDULE). */
export function isWithinOfficeHours(now: Date = new Date()): boolean {
  const { weekday, hour, minute } = madridTimeParts(now);
  const isWeekday = weekday >= 1 && weekday <= 5;
  const minutesSinceMidnight = hour * 60 + minute;
  return isWeekday && minutesSinceMidnight >= 10 * 60 && minutesSinceMidnight <= 19 * 60 + 30;
}

export function isBlockedByWorkSchedule(now: Date = new Date()): boolean {
  if (config.bypassWorkSchedule) {
    console.log("[workSchedule] bypass=1 → no bloquear");
    return false;
  }
  const { weekday, hour, minute } = madridTimeParts(now);
  const isWeekday = weekday >= 1 && weekday <= 5;
  const isWithinBlockedHours = isWithinOfficeHours(now);

  console.log("[workSchedule] decision", {
    bypass: config.bypassWorkSchedule ? "1" : "0",
    weekday,
    hour,
    minute,
    isWeekday,
    isWithinBlockedHours,
  });

  // Regla de negocio (solo si BYPASS_WORK_SCHEDULE=0): NO trabajar de L-V 10:00–19:30 (Europe/Madrid).
  return isWithinBlockedHours;
}
