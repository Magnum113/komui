import test from "node:test";
import assert from "node:assert/strict";
import { ozonDisplayAddress, ozonOpeningHours } from "../src/ozonPointPresentation";

const day = (date: string, from = "09:00:00", to = "21:00:00") => ({ date, periods: [{ from_local: from, to_local: to }] });
const week = () => Array.from({ length: 7 }, (_, i) => day(new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10)));

test("uniform dated week gets a readable summary and retains its validity dates", () => {
  assert.deepEqual(ozonOpeningHours(week().reverse()), {
    hours: "Ежедневно, 09:00–21:00",
    hoursDetails: "28 сент. – 4 окт.: 09:00–21:00",
  });
});
test("closed days and split shifts are preserved, including exceptions after the first week", () => {
  const result = ozonOpeningHours([...week(), { date: "2026-10-05", periods: [] }, {
    date: "2026-10-06", periods: [
      { from_local: "09:00:00", to_local: "13:00:00" },
      { from_local: "14:00:00", to_local: "18:00:00" },
    ],
  }]);
  assert.equal(result.hours, "28 сент. – 4 окт.: 09:00–21:00; 5 окт.: выходной; 6 окт.: 09:00–13:00, 14:00–18:00");
});
test("missing dates are not bridged into a daily schedule", () => {
  const days = week();
  days.splice(2, 1);
  const result = ozonOpeningHours(days);
  assert.equal(result.hours, "28 сент. – 29 сент.: 09:00–21:00; 1 окт. – 4 окт.: 09:00–21:00");
});
test("long irregular schedules remain complete in details instead of being cut mid-date", () => {
  const days = Array.from({ length: 21 }, (_, i) => day(new Date(Date.UTC(2026, 8, 28 + i)).toISOString().slice(0, 10), i % 2 ? "10:00:00" : "09:00:00"));
  const result = ozonOpeningHours(days);
  assert.equal(result.hours, "График зависит от даты");
  assert.ok(result.hoursDetails.endsWith("18 окт.: 09:00–21:00"));
  assert.equal(result.hoursDetails.split("; ").length, 21);
});
test("absent schedules are explicit and year boundaries remain unambiguous", () => {
  assert.deepEqual(ozonOpeningHours(), { hours: "График не указан", hoursDetails: "" });
  assert.equal(ozonOpeningHours([day("2026-12-31"), day("2027-01-01")]).hours, "31 дек. 2026 – 1 янв. 2027: 09:00–21:00");
});
test("display address removes repeated administrative prefix only for an exact city match", () => {
  const address = "Россия, Дагестан Республика, Махачкала, проспект Имама Шамиля, 4б";
  assert.equal(ozonDisplayAddress(address, "Махачкала"), "Махачкала, проспект Имама Шамиля, 4б");
  assert.equal(ozonDisplayAddress(address, "махачкала"), "Махачкала, проспект Имама Шамиля, 4б");
  assert.equal(ozonDisplayAddress(address, "Махач"), address);
  assert.equal(ozonDisplayAddress("Россия, область, Другой город, ул. Махачкала, 1", "Махачкала"), "Россия, область, Другой город, ул. Махачкала, 1");
});
