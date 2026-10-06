const originals = new Set(['m1','m2','m3','m4','m5','a1','a2','b1','b2','c1','s1','v1',
  'a1095b3c-851c-4b7f-9c51-245a1159463f','dbcf12b0-f54c-4215-a6cb-7f85be16edc3']);

// Random ranks stay stable through quantity changes and filtering during this visit.
export function createSpecials(random = Math.random) {
  const ranks = new Map();
  return items => {
    const available = items.filter(item => item.available !== false);
    const isClassic = item => originals.has(item.id) || /^chicken\s+mand(?:h)?i$/i.test(item.name?.trim() || '');
    const classic = available.filter(isClassic).slice(0,17);
    const extra = available.filter(item => !isClassic(item));
    extra.forEach(item => { if (!ranks.has(item.id)) ranks.set(item.id, random()); });
    extra.sort((a,b) => ranks.get(a.id)-ranks.get(b.id));
    return new Set([...classic,...extra.slice(0,3)].slice(0,20).map(item => item.id));
  };
}
