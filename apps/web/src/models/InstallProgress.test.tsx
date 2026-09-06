/**
 * What the download display is allowed to claim.
 *
 * This component's whole job is to say only as much as the backend actually
 * measured. There are three cases and they are not interchangeable, so each one
 * is pinned here — including, and especially, the two where no percentage
 * exists. The accessibility contract carries the same rule: `aria-valuenow` is
 * a number a screen reader will read out as fact, so it appears only when a
 * fact is available, and the indeterminate bar keeps `aria-valuetext` instead.
 *
 * The failure this guards against is the tempting one: making a bar that always
 * has a number in it by treating "unknown" as zero, or by dividing by the
 * catalogue's rounded size. Both would draw a bar that moves on a guess, and a
 * bar that moves on a guess is worse than no bar, because people plan around it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InstallProgress } from './InstallProgress';
import { makeInstall } from './testing';

/** Ten seconds after the download started, so a rate is computable. */
const STARTED = '2026-09-06T08:00:00.000Z';
const NOW = Date.parse(STARTED) + 10_000;

describe('InstallProgress with a measured total', () => {
  const install = makeInstall({
    status: 'downloading',
    detail: 'Downloading',
    startedAt: STARTED,
    bytesReceived: 3_469_039_167,
    bytesTotal: 6_938_078_334,
  });

  it('draws a determinate bar with a real aria-valuenow', () => {
    render(<InstallProgress install={install} now={NOW} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('shows both byte counts and the percentage, not just the percentage', () => {
    render(<InstallProgress install={install} now={NOW} />);
    // "how much of how big" is the thing the product owner asked for; a bare
    // percentage still leaves you unable to tell 7 GB from 700 MB.
    expect(screen.getByText('3.47 GB of 6.94 GB')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('labels the derived figures as an average and an estimate', () => {
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.getByText(/average/)).toBeInTheDocument();
    expect(screen.getByText(/estimate/)).toBeInTheDocument();
  });

  it('does not repeat the status word as a detail line', () => {
    // `detail` is "Downloading" and so is the status. Printing both was noise.
    expect(screen.queryAllByText('Downloading')).toHaveLength(0);
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.getAllByText('Downloading')).toHaveLength(1);
  });
});

describe('InstallProgress with bytes but no total', () => {
  const install = makeInstall({
    status: 'downloading',
    startedAt: STARTED,
    bytesReceived: 1_240_000_000,
    bytesTotal: null,
  });

  it('states no percentage at all, to a screen reader included', () => {
    render(<InstallProgress install={install} now={NOW} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar.getAttribute('aria-valuetext')).toBe('1.24 GB downloaded');
  });

  it('still shows how much has arrived, because that part is measured', () => {
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.getByText('1.24 GB downloaded')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });
});

describe('InstallProgress with nothing measured', () => {
  const install = makeInstall({
    status: 'downloading',
    detail: 'Downloading (1 of 3 queued tasks done)',
    startedAt: STARTED,
    bytesReceived: null,
    bytesTotal: null,
  });

  it('falls back to exactly what it showed before: no number, no bar fraction', () => {
    render(<InstallProgress install={install} now={NOW} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar.getAttribute('aria-valuetext')).toBe('Downloading (1 of 3 queued tasks done)');
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('keeps the elapsed clock, which is the only honest signal left', () => {
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.getByText('10s')).toBeInTheDocument();
  });

  it('keeps the transport’s own words when they say more than the status', () => {
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.getByText('Downloading (1 of 3 queued tasks done)')).toBeInTheDocument();
  });
});

describe('InstallProgress on a settled install', () => {
  it('shows the final size and no bar once it is installed', () => {
    const install = makeInstall({
      status: 'complete',
      detail: 'Installed and visible to ComfyUI',
      startedAt: STARTED,
      finishedAt: new Date(NOW).toISOString(),
      bytesReceived: 6_938_078_334,
      bytesTotal: 6_938_078_334,
    });
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText('6.94 GB of 6.94 GB')).toBeInTheDocument();
    // No rate on a finished install: an average over a download that has
    // stopped is a fact about the past, and nobody is waiting on it.
    expect(screen.queryByText(/average/)).not.toBeInTheDocument();
  });

  it('does not draw a bar for a failed install, but keeps the error', () => {
    const install = makeInstall({
      status: 'failed',
      error: 'The backend finished its install queue but the file is not present.',
      startedAt: STARTED,
      bytesReceived: 12_000,
      bytesTotal: 6_938_078_334,
    });
    render(<InstallProgress install={install} now={NOW} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('not present');
  });
});
