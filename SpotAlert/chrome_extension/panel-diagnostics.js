import {diagnosticActivity} from './diagnostics.js';

/** Present existing bounded metadata without writing application state. */
export function createDiagnosticsView({$, element, getState, getRecentErrors}) {
  const filters = ['category', 'location', 'severity'].map(name => $(`#diagnostics-${name}`));
  for (const filter of filters) filter.addEventListener('change', render);
  function render() {
    const state = getState();
    const monitors = state.monitors || [];
    const location = $('#diagnostics-location');
    const selected = location.value;
    location.replaceChildren(element('option', {value: 'all'}, 'All locations'), ...monitors.map(monitor => element('option', {value: monitor.id}, monitor.name)));
    location.value = [...location.options].some(option => option.value === selected) ? selected : 'all';
    const status = $('#diagnostics-status');
    status.replaceChildren(...monitors.map(monitor => element('p', {class: 'diagnostics-status-row'},
      element('strong', {}, monitor.name),
      ` · ${monitor.error ? 'Needs attention' : monitor.phase || 'paused'} · ${monitor.readMethod === 'background' ? 'Background check' : monitor.readMethod === 'browser' ? 'Browser check' : 'Check method unavailable'} · Last check: ${monitor.lastCheckedAt ? new Date(monitor.lastCheckedAt).toLocaleString() : 'Not yet checked'} · Next check: ${monitor.nextCheckAt ? new Date(monitor.nextCheckAt).toLocaleString() : 'Not scheduled'}`)));
    if (!monitors.length) status.append(element('p', {class: 'helper'}, 'No locations available.'));
    const names = new Map(monitors.map(monitor => [monitor.id, monitor.name]));
    const [category, selectedLocation, severity] = filters.map(filter => filter.value);
    const events = diagnosticActivity(state, getRecentErrors()).filter(event =>
      (category === 'all' || event.category === category) &&
      (selectedLocation === 'all' || event.location === selectedLocation) &&
      (severity === 'all' || event.severity === severity));
    $('#diagnostics-activity').replaceChildren(...events.map(event => element('li', {class: 'diagnostics-event'},
      element('time', {datetime: new Date(event.at).toISOString()}, new Date(event.at).toLocaleString()),
      element('strong', {}, event.message),
      element('span', {class: 'helper'}, `${event.category} · ${names.get(event.location) || 'General'}${event.severity === 'attention' ? ' · Needs attention' : ''}`),
      event.details && element('code', {}, event.details))));
    $('#diagnostics-empty').hidden = events.length > 0;
  }
  return {render};
}
