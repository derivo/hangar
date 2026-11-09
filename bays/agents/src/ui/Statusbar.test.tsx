import { render, screen } from '@testing-library/react';
import { Statusbar } from './Statusbar';

describe('Statusbar', () => {
  it('renders nothing without segments', () => {
    const { container } = render(<Statusbar segments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders all four segment types', () => {
    render(
      <Statusbar
        segments={[
          { key: 'modell', value: 'opus', type: 'text' },
          { key: 'worktree', value: '/tmp/wt/shop-1234', type: 'path' },
          { key: 'kontingent', value: '42', type: 'bar', max: 100 },
          { key: 'pr', value: 'offen', type: 'badge' },
        ]}
      />,
    );
    const bar = screen.getByRole('group', { name: 'Statusleiste' });
    expect(bar).toHaveTextContent('modell');
    expect(bar).toHaveTextContent('opus');
    expect(screen.getByTitle('/tmp/wt/shop-1234')).toHaveTextContent('/tmp/wt/shop-1234');
    const meter = screen.getByRole('meter', { name: 'kontingent' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter.querySelectorAll('.on')).toHaveLength(4);
    expect(bar).toHaveTextContent('42 / 100');
    expect(screen.getByText('offen')).toHaveClass('segment-badge');
  });

  it('clamps a bar whose value is not a number to zero', () => {
    render(<Statusbar segments={[{ key: 'k', value: 'viel', type: 'bar', max: 10 }]} />);
    expect(screen.getByRole('meter', { name: 'k' })).toHaveAttribute('aria-valuenow', '0');
  });

  it('shows keys and values from agents as text, never as markup', () => {
    const markup = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <Statusbar
        segments={[
          { key: markup, value: markup, type: 'text' },
          { key: 'p', value: markup, type: 'path' },
          { key: 'b', value: markup, type: 'badge' },
        ]}
      />,
    );
    expect(screen.getAllByText(markup)).toHaveLength(4);
    expect(container.querySelector('img')).toBeNull();
  });
});
