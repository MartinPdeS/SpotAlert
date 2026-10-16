import {rentCafeApplication} from './rentcafe.js';

export default {
  id: 'ourdomain-amsterdam-south-east',
  name: 'OurDomain · Amsterdam South East',
  url: 'https://southeast-thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-south-east/floorplans.aspx',
  rule: {type: 'css', selector: 'td[data-selenium-id^="Apply_"] [data-selenium-id="ApplyNow"]', mode: 'not_equals', expected: 'Get Notified'},
  reader: {includeCollapsed: true},
  ruleMigrations: [{
    from: {type: 'css', selector: 'td[data-selenium-id^="Availability_"]', mode: 'not_equals', expected: 'Get Notified'},
    message: 'South East rule corrected to read application buttons.',
  }],
  application: {...rentCafeApplication},
};
