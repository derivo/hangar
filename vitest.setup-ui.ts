import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// `findBy*`/`waitFor` give up after 1 s by default and do not check once more on timeout. If a
// loaded machine stalls the worker, their interval and timeout fall due in the same timer phase,
// before React renders the update that is already scheduled behind them – they fail although the
// answer is there. 5 s outlasts such a stall.
configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);
