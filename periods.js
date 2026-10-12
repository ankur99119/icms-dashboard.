/* Calendar windows shared by the viewer and its regression tests. */
'use strict';
window.ICMS_PERIODS = (() => {
  const DAY = 86400000;
  const valid = (iso) => typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) &&
    Number.isFinite(Date.parse(iso + 'T12:00:00Z')) &&
    new Date(iso + 'T12:00:00Z').toISOString().slice(0, 10) === iso;
  const shift = (iso, days) => new Date(Date.parse(iso + 'T12:00:00Z') + days * DAY).toISOString().slice(0, 10);
  function windowFor(today, period, from, to) {
    if (!valid(today)) throw new Error('Invalid operating date.');
    if (period === 'custom') {
      if (!valid(from) || !valid(to) || from > to || to > today) return null;
      const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
      return days <= 366 ? { start: from, end: to } : null;
    }
    if (period === 'yesterday') {
      const yesterday = shift(today, -1);
      return { start: yesterday, end: yesterday };
    }
    const months = { month: 1, quarter: 3, '6m': 6, year: 12 }[period];
    if (months) {
      const date = new Date(today + 'T12:00:00Z');
      const monthIndex = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
      const year = Math.floor(monthIndex / 12), month = monthIndex - year * 12;
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const anchor = new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay), 12))
        .toISOString().slice(0, 10);
      return { start: shift(anchor, 1), end: today };
    }
    const days = { today: 1, '7d': 7, '15d': 15 }[period];
    if (!days) return null;
    return { start: shift(today, -(days - 1)), end: today };
  }
  return { valid, shift, windowFor };
})();
