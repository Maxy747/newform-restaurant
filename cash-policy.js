// End-of-day drawer maths. The server recomputes expected cash and the counted total when a count is saved.
export const DENOMINATIONS = [500, 200, 100, 50, 20, 10, 5, 2, 1]; // notes and coins of the same value are counted together

// Keeps whole, positive piece counts only, keyed the way oms_cash_count expects ({ "500": 3 }).
export function cleanDenominations(counts) {
  const clean = {};
  for (const value of DENOMINATIONS) {
    const pieces = Number(counts?.[value]);
    if (Number.isInteger(pieces) && pieces > 0) clean[value] = pieces;
  }
  return clean;
}

export const denominationTotal = counts => Object.entries(cleanDenominations(counts)).reduce((sum, [value, pieces]) => sum + Number(value) * pieces, 0);

export function expectedDrawer(opening, summary) {
  const float = Number(opening);
  return Math.round(((Number.isFinite(float) && float > 0 ? float : 0) + Number(summary?.expected_cash || 0)) * 100) / 100;
}

export function drawerStatus(counted, expected) {
  const difference = Math.round((Number(counted) - Number(expected)) * 100) / 100;
  return { difference, state: difference === 0 ? 'match' : difference > 0 ? 'over' : 'short', amount: Math.abs(difference) };
}
