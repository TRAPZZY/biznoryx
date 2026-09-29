const state = await fetch('/api/preview-state').then((response) => response.json());

document.querySelector('#business-name').textContent = state.business.name;
document.querySelector('#release-state').textContent = state.releaseState.replaceAll('_', ' ');
document.querySelector('#production-truth').textContent = `${state.productionTruth.status.replaceAll('_', ' ')}: ${state.productionTruth.reason}`;
document.querySelector('#pulse-text').textContent = state.business.pulse;
document.querySelector('#period-text').textContent = state.business.period;

document.querySelector('#module-list').replaceChildren(...state.business.modules.map((module) => element('span', 'module-chip', module)));

document.querySelector('#metrics').replaceChildren(...state.kpis.map((kpi) => {
  const card = element('article', 'metric-card');
  card.append(element('p', 'eyebrow', kpi.status), element('h3', '', kpi.label), element('strong', '', kpi.value), element('span', 'trend', kpi.trend));
  return card;
}));

document.querySelector('#findings-list').replaceChildren(...state.findings.map((finding) => {
  const row = element('article', 'row-card');
  row.append(element('span', 'row-kind', finding.kind), element('h3', '', finding.title), element('p', '', finding.evidence));
  return row;
}));

document.querySelector('#actions-list').replaceChildren(...state.actions.map((action) => {
  const row = element('article', 'row-card');
  row.append(element('span', 'row-kind', action.status.replaceAll('_', ' ')), element('h3', '', action.title), element('p', '', `Owner: ${action.owner}`));
  return row;
}));

document.querySelector('#forecast-list').replaceChildren(...state.forecasts.map((forecast) => {
  const row = element('article', 'row-card forecast');
  row.append(element('span', 'row-kind', forecast.readiness.replaceAll('_', ' ')), element('h3', '', `${forecast.scenario} forecast`), element('p', '', `${forecast.horizon}: ${forecast.values.join(', ')}`));
  return row;
}));

document.querySelector('#gate-table').replaceChildren(...state.gates.map((gate) => {
  const row = element('article', `gate-row ${gate.state}`);
  row.append(element('strong', '', gate.name), element('code', '', gate.command), element('span', '', gate.state), element('p', '', gate.evidence));
  return row;
}));

document.querySelector('#next-work').replaceChildren(...state.nextWork.map((item) => element('li', '', item)));

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
