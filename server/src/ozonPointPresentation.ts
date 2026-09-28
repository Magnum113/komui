type Schedule = Array<{
  date: string;
  periods: Array<{ from_local: string; to_local: string }>;
}>;

// Ozon supplies dated opening periods, not a permanent weekly timetable.
export function ozonOpeningHours(schedule: Schedule = []) {
  const dates = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
  const days = schedule.map(day => {
    const timestamp = Date.parse(`${day.date}T00:00:00Z`);
    const valid = Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === day.date;
    return {
      date: day.date, timestamp: valid ? timestamp : NaN,
      label: valid ? dates.format(timestamp) : day.date,
      hours: day.periods.length
        ? day.periods.map(p => `${p.from_local.slice(0, 5)}–${p.to_local.slice(0, 5)}`).join(", ")
        : "выходной",
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return { hours: "График не указан", hoursDetails: "" };
  const crossesYear = days[0].date.slice(0, 4) !== days[days.length - 1].date.slice(0, 4);
  if (crossesYear) days.forEach(day => { day.label += ` ${day.date.slice(0, 4)}`; });
  const groups: Array<{ first: typeof days[number]; last: typeof days[number] }> = [];
  for (const day of days) {
    const group = groups[groups.length - 1];
    if (group && day.timestamp - group.last.timestamp === 86400000 && day.hours === group.last.hours) group.last = day;
    else groups.push({ first: day, last: day });
  }
  const hoursDetails = groups.map(({ first, last }) =>
    `${first.label}${first !== last ? ` – ${last.label}` : ""}: ${first.hours}`,
  ).join("; ");
  const daily = groups.length === 1 && days.length >= 7 && days[0].hours !== "выходной";
  const summary = daily ? `Ежедневно, ${days[0].hours}` : hoursDetails;
  // The existing checkout/email contract allows 160 characters. Never cut a date or shift.
  return { hours: summary.length <= 160 ? summary : "График зависит от даты", hoursDetails };
}

export function ozonDisplayAddress(address: string, city: string) {
  const parts = address.split(",").map(part => part.trim()).filter(Boolean);
  const cityIndex = city ? parts.findIndex(part => part.toLocaleLowerCase("ru-RU") === city.trim().toLocaleLowerCase("ru-RU")) : -1;
  // Shorten only when the exact requested city is a separate address component.
  // Keep the original address when the search is partial or the locality differs.
  return cityIndex >= 0 ? parts.slice(cityIndex).join(", ") : address;
}
