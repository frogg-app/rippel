import { describe, expect, it } from 'vitest';
import { factSpan } from './FitFact';
import { drawerFit } from './cardFacts';

describe('fit tile span', () => {
  const three = '180px 180px 180px';

  it('takes one column when the pill fits', () => {
    expect(factSpan(120, three, 8)).toBe(1);
    expect(factSpan(180, three, 8)).toBe(1);
  });

  it('takes two when one is short, counting the gap between them', () => {
    expect(factSpan(181, three, 8)).toBe(2);
    expect(factSpan(368, three, 8)).toBe(2);
  });

  it('takes the whole row only when it truly needs it, and never more', () => {
    expect(factSpan(369, three, 8)).toBe(3);
    expect(factSpan(900, three, 8)).toBe(3);
    expect(factSpan(300, '150px 150px', 8)).toBe(2);
  });

  it('falls back to one column when the template is unresolved', () => {
    expect(factSpan(500, 'none', 8)).toBe(1);
    expect(factSpan(500, '', 8)).toBe(1);
  });
});

describe('drawer fit label', () => {
  const fit = { label: '9.37 GB · not supported yet', tone: 'warn' as const, detail: '' };

  it('drops the size the Size tile already shows', () => {
    expect(drawerFit(fit, 9.37e9).label).toBe('Not supported yet');
    expect(drawerFit({ ...fit, label: '7.00 GB · fits' }, 7e9).label).toBe('Fits');
  });

  it('leaves a label without the size prefix alone', () => {
    expect(drawerFit({ ...fit, label: 'Not supported yet' }, null).label).toBe('Not supported yet');
    expect(drawerFit({ ...fit, label: '7.00 GB' }, 7e9).label).toBe('7.00 GB');
  });
});
