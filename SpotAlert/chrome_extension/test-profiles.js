import {generateRegistrationPassword, validateProfile} from "./profile.js";

/** Coherent fictional applicants, with reserved example.com email destinations. */
export function createTestProfile(index) {
  if (![1, 2].includes(index)) throw new Error("Choose test profile 1 or 2.");
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const pick = (items, offset) => items[bytes[offset] % items.length];
  const firstName = index === 1 ? pick(["Daan", "Thomas", "Lars", "Bram", "Jesse", "Ruben"], 0) : pick(["Sophie", "Emma", "Julia", "Sanne", "Lotte", "Eva"], 0);
  const lastName = pick(["de Vries", "Bakker", "van Dijk", "Visser", "de Jong", "Smit"], 1);
  const contactName = pick(["Milan", "Lucas", "Nora", "Lisa", "Femke", "Tim"], 2);
  const contactLastName = pick(["Jansen", "Bos", "Meijer", "Mulder", "de Groot", "Vos"], 3);
  const suffix = [...bytes.slice(8)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const phone = offset => `+3160000${String((bytes[offset] * 256 + bytes[offset + 1]) % 10000).padStart(4, "0")}`;
  const year = (index === 1 ? 1993 : 1996) + bytes[4] % 4;
  const month = 1 + bytes[5] % 12, day = 1 + bytes[6] % 28;
  const persona = index === 1 ? {
    city: "Utrecht", address: `Lindehof ${12 + bytes[7] % 40}`, postalCode: "3513 KD", monthlyHousingCost: "925",
    jobTitle: "Software developer", employer: "Noordlicht Digital", monthlyIncome: String(4100 + bytes[3] % 8 * 100),
    employerAddress: "Stationshof 18", employerPostalCode: "3511 CE", employerCity: "Utrecht",
    university: "Hogeschool Utrecht", study: "Software Engineering", maxRent: "1450", minSize: "28", preferredApartmentType: "studio",
    reasonForMoving: "Moving closer to my new office in Amsterdam and looking for a place of my own.",
  } : {
    city: "Rotterdam", address: `Meidoornsingel ${21 + bytes[7] % 50}`, postalCode: "3039 LH", monthlyHousingCost: "1080",
    jobTitle: "UX designer", employer: "Atelier Rivier", monthlyIncome: String(3700 + bytes[3] % 8 * 100),
    employerAddress: "Westhavenhof 7", employerPostalCode: "3016 DM", employerCity: "Rotterdam",
    university: "Hogeschool Rotterdam", study: "Communication and Multimedia Design", maxRent: "1750", minSize: "42", preferredApartmentType: "1-bedroom",
    reasonForMoving: "My current lease is ending. I am looking for a quieter apartment with space to work from home.",
  };
  const emailName = `${firstName}.${lastName}`.toLowerCase().replace(/\s+/g, '');
  return {
    id: `spotalert-test-profile-${index}`, name: `Test profile ${index} · ${firstName} ${lastName}`, testProfile: true,
    details: validateProfile({
      ...persona, title: index === 1 ? "Mr." : "Ms.", firstName, lastName, noMiddleName: "Yes",
      dateOfBirth: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      registrationPassword: generateRegistrationPassword(), email: `${emailName}.${suffix}@example.com`,
      phone: phone(8), nationality: "Dutch", countryOfResidence: "Netherlands", country: "Netherlands", contactMethod: "Email",
      housingType: "Rent", residencyFrom: index === 1 ? "2023-09-01" : "2024-02-01",
      employmentStatus: "Employed", employedSince: index === 1 ? "2021-08-01" : "2022-04-01", employerCountry: "Netherlands", additionalIncome: "0",
      emergencyName: `${contactName} ${contactLastName}`, emergencyRelationship: "Friends", emergencyPhone: phone(10),
      emergencyCountry: "Netherlands", emergencyAddress: "Esdoornhof 32", emergencyPostalCode: "3812 LM", emergencyCity: "Amersfoort",
      graduated: "Yes", phd: "No", hasPets: "No", hasVehicles: index === 1 ? "No" : "Yes", receiveEmail: "Yes", receiveSms: "No", nlCitizen: "Yes",
    }),
  };
}
