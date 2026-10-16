import {rentCafeApplication} from './rentcafe.js';

export default {
  id: 'ourdomain-amsterdam-diemen',
  name: 'OurDomain · Amsterdam Diemen',
  url: 'https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx',
  rule: {type: 'css', selector: 'td[data-selenium-id^="Availability_"]', mode: 'not_equals', expected: 'Get Notified'},
  reader: {includeCollapsed: false},
  application: {...rentCafeApplication},
};
