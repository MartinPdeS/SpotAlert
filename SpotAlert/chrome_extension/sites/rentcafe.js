/** Shared RentCafe capabilities. All entries are serializable for script injection. */
export const rentCafeApplication = {
  provider: 'rentcafe',
  readiness: {requiredFields: ['firstName', 'lastName', 'email', 'phone'], reviewFields: ['dateOfBirth', 'address', 'postalCode', 'city'], note: 'Address and birth date are commonly requested. Live website validation may require additional details.'},
  preferFloorplanEntry: false,
  paths: {floorplans: 'floorplans.aspx', units: 'availableunits.aspx', booking: 'termsandotheritems.aspx', applicant: 'oleapplication.aspx'},
  booking: {waitMs: 20000, retryAfterMs: 15000, maxAttempts: 3},
  agreementSignature: null,
};
