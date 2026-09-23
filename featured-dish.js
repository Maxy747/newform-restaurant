export function featuredDish(items) {
  const available = items.filter(item => item.available !== false);
  return available.find(item => item.id === 'm1') ||
    available.find(item => /chicken\s+mandhi/i.test(item.name)) || available[0] || null;
}
export function featuredPrice(item, portion) {
  if (!item) return null;
  const value = item.portionType === 'multi' ? item.prices?.[portion] : item.price;
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
}
