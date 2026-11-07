// Shared test fixture: what the AI answers for a Marketing Plan prompt —
// in-app tasks (services/planCatalog.js actions) for each phase the prompt
// names. Used by the suites that fake the plan provider.
// Note: "Plan the …" / "Review …" wording kept for the suites' own checks.
function tasks(phase) {
  return [
    { title: 'Plan the ' + phase + ' ad copy', why: 'Workshops fill on Saturdays', what: 'Write three headlines in Create', action: 'create_ad_copy' },
    { title: 'Build the ' + phase + ' audience', why: 'Gift shoppers buy most', what: 'Save the audience in Audience Builder', action: 'build_audience' },
    { title: 'Review ' + phase + ' results', why: 'See what works', what: 'Review the campaigns in Campaign Overview', action: 'review_campaigns' },
  ];
}
// Is this system prompt one of the Marketing Plan calls (strategy + first
// chunk, or a later chunk of the roadmap)?
function isPlanPrompt(sys) {
  return /strategy and action plan covering the next|You are continuing the .* action plan/.test(String(sys || ''));
}
// The phase names the prompt asks for.
function phasesOf(sys) {
  const m = String(sys || '').match(/"roadmap":\[(.*)\]\}\s*\nRoadmap:/);
  return m ? Array.from(m[1].matchAll(/"phase":"([^"]+)"/g)).map((x) => x[1]) : [];
}
function roadmapFor(sys) { return phasesOf(sys).map((n) => ({ phase: n, focus: 'Focus', tasks: tasks(n) })); }

module.exports = { tasks, isPlanPrompt, phasesOf, roadmapFor };
