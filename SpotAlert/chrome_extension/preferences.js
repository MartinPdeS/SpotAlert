export function preferenceMatch(sample, profile = {}) {
  const number = value => {
    const match = String(value || '').match(/\d[\d.,]*/);
    if (!match) return null;
    let text = match[0].replace(/[.,]+$/, '');
    if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{2})?$/.test(text)) text = text.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '');
    else if (text.includes('.') && text.includes(',')) text = text.replace(/\.(?=\d{3})/g, '');
    return Number(text.replace(',', '.'));
  };
  const reasons = [];
  if (profile.preferredApartmentType && profile.preferredApartmentType !== sample.apartmentType) reasons.push(`Different apartment type: ${sample.apartmentType || 'not published'}; wants ${profile.preferredApartmentType}`);
  if (profile.maxRent) {
    const rents = String(sample.rent || '').match(/\d[\d.,]*/g)?.map(number).filter(Number.isFinite) || [];
    const rent = rents.length ? Math.max(...rents) : null;
    if (rent === null) reasons.push('Rent not published');
    else if (rent > Number(profile.maxRent)) reasons.push(`€${Number((rent - Number(profile.maxRent)).toFixed(2)).toLocaleString('en-GB')} over budget (€${Number(profile.maxRent).toLocaleString('en-GB')} maximum)`);
  }
  if (profile.minSize) {
    let area = number(sample.size);
    if (/sq\.?\s*ft|ft²|ft2/i.test(sample.size || '') && area !== null) area *= 0.092903;
    if (area === null) reasons.push('Size not published');
    else if (area < Number(profile.minSize)) reasons.push(`${Number((Number(profile.minSize) - area).toFixed(2))} m² below minimum (${profile.minSize} m² required)`);
  }
  return {included: !reasons.length, reasons};
}
