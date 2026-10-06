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

export function createFeaturedSelector({specials, storage, random = Math.random}) {
  let previous = null, current = null;
  try { previous = storage?.getItem('newform-featured-last'); } catch {}
  return items => {
    const ids = specials(items);
    const candidates = items.filter(item => item.available !== false && ids.has(item.id));
    const existing = candidates.find(item => item.id === current);
    if (existing) return existing;
    const alternatives = candidates.filter(item => item.id !== previous && item.id !== current);
    const pool = alternatives.length ? alternatives : candidates;
    const chicken = candidates.find(item => /^chicken\s+mand(?:h)?i$/i.test(item.name.trim())) || candidates.find(item => item.id === 'm1');
    const chosen = !previous && !current && chicken ? chicken : pool[Math.floor(random() * pool.length)] || null;
    current = chosen?.id || null;
    if (current) { try { storage?.setItem('newform-featured-last', current); } catch {} }
    return chosen;
  };
}
