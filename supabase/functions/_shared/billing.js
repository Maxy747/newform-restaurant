// Billing rules shared by the Edge Function and the admin console. The database enforces the same limits.
export const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// GST state codes, used to print the place of supply from the restaurant's GSTIN.
export const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

const text = (value, max) => typeof value === 'string' ? value.trim().replace(/\s+\n/g, '\n').slice(0, max) : '';

// Cleans an admin's billing form into a settings row, with messages a restaurant owner can act on.
export function normalizeBillingSettings(input = {}) {
  const row = {
    enabled: input.enabled === true,
    legal_name: text(input.legal_name, 120),
    address: text(input.address, 300),
    phone: text(input.phone, 40) || null,
    gstin: text(input.gstin, 20).toUpperCase().replace(/\s/g, '') || null,
    fssai: text(input.fssai, 20).replace(/\s/g, '') || null,
    sac: text(input.sac, 8) || '996331',
    prefix: text(input.prefix, 3).toUpperCase() || 'NF',
    footer: text(input.footer, 200),
  };
  if (row.gstin && !GSTIN.test(row.gstin)) throw new Error('GSTIN should be the 15-character number on your GST certificate, e.g. 32ABCDE1234F1Z5');
  if (row.fssai && !/^[0-9]{14}$/.test(row.fssai)) throw new Error('FSSAI licence number should be 14 digits');
  if (!/^[0-9]{4,8}$/.test(row.sac)) throw new Error('SAC code should be 4–8 digits (restaurant service is 996331)');
  if (!/^[A-Z0-9]{1,3}$/.test(row.prefix)) throw new Error('Invoice prefix should be 1–3 letters or digits, e.g. NF');
  if (row.enabled && (!row.legal_name || !row.address)) throw new Error('Enter the business name and address before turning invoicing on');
  return row;
}

export const placeOfSupply = gstin => {
  const code = typeof gstin === 'string' ? gstin.slice(0, 2) : '';
  return GST_STATES[code] ? `${GST_STATES[code]} (${code})` : null;
};
