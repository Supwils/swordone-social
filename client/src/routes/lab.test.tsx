import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('@/features/lab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/lab')>();
  return { ...actual, LabV2Page: () => <div>lab-v2</div> };
});

import LabRoute from './lab';

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/lab" element={<LabRoute />} />
        <Route path="/lab/v1" element={<div>v1</div>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('/lab route', () => {
  it.each(['/lab?era=2', '/lab?view=benchmark', '/lab?view=graph&agent=xiaoman'])(
    '%s redirects to /lab/v1 with the same query',
    (path) => {
      renderAt(path);
      expect(screen.getByText('v1')).toBeTruthy();
      expect(screen.getByTestId('where').textContent).toBe(path.replace('/lab', '/lab/v1'));
    },
  );

  it.each(['/lab?agent=xiaoman', '/lab?era=3&agent=x', '/lab?view=dashboard&agent=x'])(
    '%s stays on v2',
    (path) => {
      renderAt(path);
      expect(screen.getByText('lab-v2')).toBeTruthy();
      expect(screen.getByTestId('where').textContent).toBe(path);
    },
  );
});
