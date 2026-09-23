import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({
  root, configFile: false, mode: 'test', appType: 'custom',
  server: {middlewareMode: true, hmr: false, ws: false, watch: null},
  optimizeDeps: {noDiscovery: true, include: []},
});
let passed = 0;
function check(label, run) {
  run();
  passed++;
  console.log(`PASS ${label}`);
}

try {
  const {stateValues, stateLabel, matchesState, organizationStateLabel, compareOrganizationStates, stateOptions} =
    await vite.ssrLoadModule('/lib/states.ts');

  check('mixed case, full names, and delimiters yield unique recorded states', () => {
    assert.deepEqual(stateValues(' In ; Illinois / IN, Michigan '), ['IL', 'IN', 'MI']);
    assert.deepEqual(stateValues(' new   york ; DC '), ['DC', 'NY']);
  });
  check('blank or empty delimiters stay unknown without inventing geography', () => {
    assert.deepEqual(stateValues(' ; , / '), []);
    assert.deepEqual(stateValues('National'), ['NATIONAL']);
    assert.deepEqual(stateValues('Indiana office'), ['INDIANA OFFICE']);
  });
  check('state labels expand codes and preserve non-state source classifications', () => {
    assert.equal(stateLabel('IL'), 'Illinois');
    assert.equal(stateLabel('all'), 'All states');
    assert.equal(stateLabel('unknown'), 'State not recorded');
    assert.equal(stateLabel('NATIONAL'), 'NATIONAL');
    assert.equal(organizationStateLabel('in, IL'), 'Illinois, Indiana');
    assert.equal(organizationStateLabel(''), 'State not recorded');
  });
  check('a multi-state organization matches either recorded state without substring matches', () => {
    assert.equal(matchesState('IL, IN', 'IN'), true);
    assert.equal(matchesState('IL, IN', 'Illinois'), true);
    assert.equal(matchesState('IL, IN', 'MI'), false);
    assert.equal(matchesState('Indiana office', 'IN'), false);
  });
  check('all and not-recorded filters cover the intended records', () => {
    assert.equal(matchesState('', 'all'), true);
    assert.equal(matchesState('MI', 'all'), true);
    assert.equal(matchesState(' ', 'unknown'), true);
    assert.equal(matchesState('IN', 'unknown'), false);
    assert.equal(matchesState('', 'IN'), false);
  });
  check('state options include only recorded categories and always offer missing values', () => {
    const values = Object.freeze(['MI', 'IN, IL', 'Illinois', '', ' il ']);
    assert.deepEqual(stateOptions(values), [
      {value: 'all', label: 'All states'},
      {value: 'IL', label: 'Illinois'},
      {value: 'IN', label: 'Indiana'},
      {value: 'MI', label: 'Michigan'},
      {value: 'unknown', label: 'State not recorded'},
    ]);
    assert.deepEqual(values, ['MI', 'IN, IL', 'Illinois', '', ' il ']);
    assert.deepEqual(stateOptions([]), [
      {value: 'all', label: 'All states'},
      {value: 'unknown', label: 'State not recorded'},
    ]);
  });
  check('state sorting uses full names, alphabetizes ties, and puts missing last', () => {
    const organizations = [
      {name: 'Missing Alpha', state: ''},
      {name: 'Arkansas', state: 'AR'},
      {name: 'Alaska', state: 'AK'},
      {name: 'Alabama', state: 'AL'},
      {name: 'Indiana Zulu', state: 'IN'},
      {name: 'Indiana Alpha', state: 'in'},
      {name: 'Missing Zulu', state: ' '},
    ];
    assert.deepEqual([...organizations].sort(compareOrganizationStates).map(o => o.name), [
      'Alabama', 'Alaska', 'Arkansas', 'Indiana Alpha', 'Indiana Zulu', 'Missing Alpha', 'Missing Zulu',
    ]);
    assert.equal(organizations[0].name, 'Missing Alpha');
    assert.equal(compareOrganizationStates({name: 'Same', state: 'IN, IL'}, {name: 'Same', state: 'il/in'}), 0);
  });
  check('expense classification remains independent of client state and split assignments', () => {
    const payments = [
      {state: 'IN', amount: 10000, allocations: [{state: 'IL', amount: 3000}, {state: 'IN', amount: 7000}]},
      {state: '', amount: 5000, allocations: [{state: 'IN', amount: 5000}]},
      {state: 'Il', amount: 2000, allocations: []},
    ];
    assert.equal(payments.filter(p => matchesState(p.state, 'IN')).reduce((sum, p) => sum + p.amount, 0), 10000);
    assert.equal(payments.filter(p => matchesState(p.state, 'IL')).reduce((sum, p) => sum + p.amount, 0), 2000);
    assert.equal(payments.filter(p => matchesState(p.state, 'unknown')).reduce((sum, p) => sum + p.amount, 0), 5000);
  });
  console.log(`${passed} state checks passed.`);
} finally {
  await vite.close();
}
