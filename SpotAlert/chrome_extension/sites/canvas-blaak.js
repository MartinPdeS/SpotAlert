import {rentCafeApplication} from './rentcafe.js';

export default {
  id: 'canvas-rotterdam-blaak',
  name: 'Canvas · Rotterdam Blaak',
  url: 'https://canvas-world.securerc.co.uk/onlineleasing/andre-van-der-louwbrug-4-rotterdam-3011-wm/floorplans.aspx',
  rule: {type: 'css', selector: 'td[data-selenium-id^="Apply_"] [data-selenium-id="ApplyNow"], td[data-selenium-id^="Availability_"]', mode: 'contains', expected: 'Check availability'},
  reader: {includeCollapsed: true},
  application: {
    ...rentCafeApplication,
    preferFloorplanEntry: true,
    readiness: {
      ...rentCafeApplication.readiness,
      reviewFields: ['title', 'dateOfBirth', 'nationality', 'countryOfResidence', 'address', 'postalCode', 'city', 'residencyFrom', 'monthlyHousingCost', 'reasonForMoving', 'emergencyName', 'emergencyRelationship', 'emergencyPhone', 'emergencyAddress', 'emergencyPostalCode', 'emergencyCity', 'university', 'study', 'graduated', 'phd', 'hasPets', 'hasVehicles', 'receiveEmail', 'receiveSms'],
      middleNameChoice: true,
      note: 'Known Canvas applicant fields are checked. Missing fields will stop automation for your input; agreements, documents and final submission remain manual.',
    },
    agreementSignature: {step: 'intapplicantinfo', agreementId: 'chkAgreement', screeningId: 'chkTandCAgree', optionId: 'signatureOption2', optionLabel: 'Signature Type 1', toggleId: 'ToggleScriptSignatureLin', panelId: 'scriptSig', typeId: 'usersignatureType', typeValue: '1', fontId: 'usersignatureFont', fontValue: '2'},
  },
};
