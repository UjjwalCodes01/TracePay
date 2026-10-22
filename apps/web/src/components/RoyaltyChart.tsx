import type { AgCartesianChartOptions } from 'ag-charts-community';
import { AgCharts } from 'ag-charts-react';
import { useMemo } from 'react';
import { chartTheme, SERIES_COLORS } from '../lib/charts';
import { formatMoney } from '../lib/format';

export type RecipientTotal = { recipient: string; amount: number };

/** The chart's height for this many recipients — the ledger reserves exactly this while the chart loads. */
export const royaltyChartHeight = (recipients: number) => Math.max(140, 44 * recipients + 50);

/** Long names would push the bars off a phone: drop the "(…)" part, then shorten. */
function shortName(name: string, max: number): string {
  const plain = name.replace(/\s*\([^)]*\)\s*$/, '');
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** Total per recipient for the ledger rows shown. Its own chunk, so AG Charts never delays the grid. */
export default function RoyaltyChart({ data }: { data: RecipientTotal[] }) {
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const height = royaltyChartHeight(data.length);
  const options = useMemo<AgCartesianChartOptions>(
    () => ({
      theme: chartTheme,
      data,
      height,
      // Room for the value label at the end of the longest bar.
      padding: { right: 64 },
      series: [
        {
          type: 'bar',
          direction: 'horizontal',
          xKey: 'recipient',
          yKey: 'amount',
          yName: 'Amount',
          fill: SERIES_COLORS[0],
          label: { enabled: true, placement: 'outside-end', formatter: ({ value }: { value: number }) => formatMoney(Math.round(value * 100)) },
          tooltip: { renderer: ({ datum }: { datum: RecipientTotal }) => ({ title: datum.recipient, content: formatMoney(Math.round(datum.amount * 100)) }) },
        },
      ],
      axes: {
        x: { type: 'category', position: 'left', label: { formatter: ({ value }: { value: string }) => shortName(String(value), narrow ? 16 : 28) } },
        y: { type: 'number', position: 'bottom', label: { formatter: ({ value }: { value: number }) => formatMoney(Math.round(value * 100)) } },
      },
      legend: { enabled: false },
    }),
    [data, height, narrow],
  );
  // A fixed-size box, so the chart draws on first paint instead of waiting for a resize.
  return <AgCharts options={options} style={{ width: '100%', height }} />;
}
