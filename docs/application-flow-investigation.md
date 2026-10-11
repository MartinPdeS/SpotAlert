# OurDomain application-flow investigation

Inspected on 2026-10-11 using an isolated Chrome profile, without logging in,
reserving a unit, entering personal information, or submitting an application.

## Confirmed observations

- Diemen displayed six floor plans, all with Get Notified actions; responsive
  copies repeated those actions. South East displayed ten, also all Get Notified.
- Those actions call a contact dialog with `isNotify=1` and a `myFloorPlanId`.
  They register interest; they are not evidence of a live apartment application.
- No actual available-unit application link appeared during inspection.
- South East's published introduction says the application asks for personal
  contact details, document uploads, and an online €100 application-fee payment.
- Its published criteria list documents by apartment category. Examples include
  identity documents, a portrait picture, employment contracts and recent payslips,
  or business-registration and annual-statement documents. Exact requirements
  depend on the selected apartment and applicant circumstances.

## Unconfirmed parts

The application's exact URL, required field IDs, login requirements, document
upload controls, reservation behavior, payment flow, and submission steps cannot
be established from the currently unavailable floor plans.

The older captured page scripts reference an `availableunits` content class.
A read-only probe of the corresponding `availableunits.aspx` route received
Cloudflare verification (403) on both properties. This inferred route is not a
confirmed live application link. The South East GO search left the page on floor
plans; Diemen's GO control was obstructed by the cookie dialog during this probe.

## Existing extension behavior

The page reader records an application's actual same-origin HTTP(S) link when
present, along with the floor-plan ID, name, rent and availability. Alerts retain
listing metadata. For JavaScript actions, Open application clicks the page's real
control when it is available. No guessed application URL should be substituted.
Personal-information filling is user-triggered, fills recognized empty fields,
and does not upload documents, accept consent, pay, or submit.

## Next investigation when a real unit is available

1. Preserve the available listing's actual link and floor-plan/unit identifiers.
2. Inspect its destination and redirects before enabling any automatic navigation.
3. Identify whether opening the action itself reserves or holds a unit.
4. Record form structure: labels, field IDs, required flags, select options,
   file-upload constraints, and step/button labels. Exclude field values,
   passwords, cookies, identity documents and payment details from diagnostics.
5. Match the saved contact profile to the actual form and add a checklist for
   apartment-specific document requirements.
6. Keep reservation, final submission and payment under explicit user control.

## Sources

- [South East floor plans](https://southeast-thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-south-east/floorplans.aspx)
- [Diemen floor plans](https://thisisourdomain.securerc.co.uk/onlineleasing/ourdomain-amsterdam-diemen2/floorplans.aspx)
- [South East criteria](https://www.thisisourdomain.nl/amsterdam-south-east/criteria)
- [Diemen criteria](https://www.thisisourdomain.nl/amsterdam-diemen/criteria)
