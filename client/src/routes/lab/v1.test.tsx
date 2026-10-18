import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';

vi.mock('@/features/lab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/lab')>();
  return { ...actual, LabPage: () => <div>v1-lab-page</div> };
});

import LabV1Route from './v1';

afterEach(cleanup);

describe('/lab/v1 route', () => {
  it('renders today’s LabPage under a one-line banner linking to the new lab', () => {
    render(
      <MemoryRouter initialEntries={['/lab/v1?era=2']}>
        <LabV1Route />
      </MemoryRouter>,
    );
    expect(screen.getByText('v1-lab-page')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain(
      'This is the older lab view, kept unchanged.',
    );
    expect(screen.getByRole('link', { name: 'Open the new lab' }).getAttribute('href')).toBe(
      '/lab',
    );
  });
});
