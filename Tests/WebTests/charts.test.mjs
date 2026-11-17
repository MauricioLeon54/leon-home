import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSeries } from '../../.build/web-modules/charts.js';

test('missing samples split chart lines instead of inventing zero traffic', () => {
  assert.deepEqual(
    splitSeries(
      [
        [1, 3],
        [null, 4],
        [2, null],
      ],
      0,
      200,
      20,
      4
    ),
    [[[0, 17]], [[200, 14]]]
  );
});

test('a real zero sample remains a point on the baseline', () => {
  assert.deepEqual(splitSeries([[0, null]], 0, 200, 20, 4), [[[200, 20]]]);
});
