const stateNames: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const stateCodes = new Map(Object.entries(stateNames).map(([code, name]) => [name.toUpperCase(), code]));
const alphabetical = (a: string, b: string) => a.localeCompare(b, 'en', {sensitivity: 'base'});

export function stateLabel(value: string): string {
  if (value === 'all') return 'All states';
  if (value === 'unknown') return 'State not recorded';
  const normalized = value.trim().replace(/\s+/g, ' ').toUpperCase();
  return stateNames[normalized] ?? stateNames[stateCodes.get(normalized) ?? ''] ?? normalized;
}

// These labels come from the tracker; an organization's name never supplies geography.
export function stateValues(value: string): string[] {
  const values = value.split(/[,;/]/).map(part => {
    const normalized = part.trim().replace(/\s+/g, ' ').toUpperCase();
    return stateCodes.get(normalized) ?? normalized;
  }).filter(Boolean);
  return [...new Set(values)].sort((a, b) => alphabetical(stateLabel(a), stateLabel(b)));
}

export function matchesState(recorded: string, selected: string): boolean {
  if (selected === 'all') return true;
  const values = stateValues(recorded);
  if (selected === 'unknown') return values.length === 0;
  const selection = stateValues(selected);
  return selection.length === 1 && values.includes(selection[0]);
}

export function organizationStateLabel(value: string): string {
  const values = stateValues(value);
  return values.length ? values.map(stateLabel).join(', ') : stateLabel('unknown');
}

export function compareOrganizationStates(
  a: {state: string; name: string},
  b: {state: string; name: string},
): number {
  const aMissing = stateValues(a.state).length === 0;
  const bMissing = stateValues(b.state).length === 0;
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  return alphabetical(organizationStateLabel(a.state), organizationStateLabel(b.state)) || alphabetical(a.name, b.name);
}

export function stateOptions(values: string[]): {value: string; label: string}[] {
  const states = [...new Set(values.flatMap(stateValues))]
    .sort((a, b) => alphabetical(stateLabel(a), stateLabel(b)));
  return [
    {value: 'all', label: stateLabel('all')},
    ...states.map(value => ({value, label: stateLabel(value)})),
    {value: 'unknown', label: stateLabel('unknown')},
  ];
}
