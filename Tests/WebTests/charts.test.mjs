import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSeries } from '../../.build/web-modules/charts.js';
import { isNonzeroNumber } from '../../.build/web-modules/core/format.js';

test('missing samples split chart lines instead of inventing zero traffic', () => {
  assert.deepEqual(
    splitSeries(
      [
        [1, 3],
        [null, 4],
        [2, null],
      ],
      0,
      { width: 200, height: 20, max: 4 }
    ),
    [[[0, 17]], [[200, 14]]]
  );
});

test('a real zero sample remains a point on the baseline', () => {
  assert.deepEqual(splitSeries([[0, null]], 0, { width: 200, height: 20, max: 4 }), [[[200, 20]]]);
});

test('display truthiness keeps zero, empty and NaN behavior explicit', () => {
  for (const value of [null, undefined, 0, -0, NaN]) assert.equal(isNonzeroNumber(value), false);
  for (const value of [-1, 1, Infinity]) assert.equal(isNonzeroNumber(value), true);
});
