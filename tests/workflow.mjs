import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(process.argv[2] ?? new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const concurrency = source.match(/^concurrency:\n((?:[ \t].*\n|\n)*)/m)?.[1];
assert.ok(concurrency, 'workflow must configure concurrency');
assert.match(concurrency, /^  cancel-in-progress: true$/m, 'superseded runs must still cancel');
const template = concurrency.match(/^  group: (.+)$/m)?.[1];
assert.ok(template, 'workflow must use a single-line concurrency group');

// Evaluate only property lookups and ||; actionlint checks the full workflow syntax.
function group(github) {
  return template.replace(/\$\{\{\s*([^{}]+?)\s*\}\}/g, (_, expression) => {
    const values = expression.split('||').map(property => {
      const path = property.trim().split('.');
      assert.equal(path.shift(), 'github', 'unsupported expression context');
      assert.ok(path.every(name => /^[a-z_]+$/.test(name)), 'unsupported expression');
      return path.reduce((value, name) => value?.[name], github);
    });
    return values.find(value => value !== undefined && value !== null && value !== '' && value !== false && value !== 0) ?? '';
  });
}

function context(event_name, ref, number) {
  return {
    workflow: 'CI', event_name, ref,
    ref_name: ref.replace(/^refs\/(heads|pull)\//, ''),
    head_ref: number ? 'review/ci-concurrency' : '',
    event: number ? { pull_request: { number } } : {},
    sha: 'old',
  };
}

const branch = 'refs/heads/review/ci-concurrency';
const contexts = [
  ['review push', context('push', branch)],
  ['pull request', context('pull_request', 'refs/pull/9/merge', 9)],
  ['same-named fork PR', context('pull_request', 'refs/pull/10/merge', 10)],
  ['manual run', context('workflow_dispatch', branch)],
  ['main push', context('push', 'refs/heads/main')],
  ['other workflow', { ...context('push', branch), workflow: 'Other' }],
];

let checks = 0;
for (const [index, [name, github]] of contexts.entries()) {
  for (const [otherName, other] of contexts.slice(index + 1)) {
    assert.notEqual(group(github), group(other), `${name} must not cancel ${otherName}`);
    ++checks;
  }
  assert.equal(group(github), group({ ...github, sha: 'new' }), `${name} must cancel its superseded run`);
  ++checks;
}
console.log(`workflow: ${checks} concurrency isolation and supersession cases passed`);
