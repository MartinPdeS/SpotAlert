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
  if (profile.preferredApartmentType && profile.preferredApartmentType !== sample.apartmentType) reasons.push('Different apartment type');
  if (profile.maxRent) {
    const rents = String(sample.rent || '').match(/\d[\d.,]*/g)?.map(number).filter(Number.isFinite) || [];
    const rent = rents.length ? Math.max(...rents) : null;
    if (rent === null) reasons.push('Rent not published');
    else if (rent > Number(profile.maxRent)) reasons.push('Over budget');
  }
  if (profile.minSize) {
    let area = number(sample.size);
    if (/sq\.?\s*ft|ft²|ft2/i.test(sample.size || '') && area !== null) area *= 0.092903;
    if (area === null) reasons.push('Size not published');
    else if (area < Number(profile.minSize)) reasons.push('Below minimum size');
  }
  return {included: !reasons.length, reasons};
}
